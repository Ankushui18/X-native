import { allowTopologyEdit, topologyEditBlocked, NETWORK_EDIT_LIMIT } from "./vectorCapabilities";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Effect, Engine, ImageFit, Interaction, ListStyle, NodeKind, PathPoint, ProtoAnim, ProtoTrigger, RulerGuide, Snapshot, StrokeCap, Tool, VectorNetwork, VariableWidthPoint, XNode } from "../engine/types";
import { checkCondition, triggerInteractions } from "../engine/protoEval";
import { resolveAllForMode, resolveVariable } from "../engine/variables";
import { evaluateExpression } from "../engine/expressions";
import { prefersReducedMotion } from "./a11y";
import { deepestFrame, defaultEffect, find, findParent, hitTest, insideInstance, isEffectivelyLocked, isInstanceMember, localToWorld, parentHandedness, previewBoolean, worldDeltaToParent, worldPointToParent, worldToLocal } from "../engine/memory";
// The canvas reads a layer's placement *including its ancestors' rotation and
// flips*: the selection box, handles and drag maths must land where the layer
// is painted, not where it would be if its parent were unrotated. The engine's
// own `worldPos` stays translation-only (it is a reparenting offset there).
import { worldPlacement as worldPos } from "../engine/memory";
import { isPointBoxCorner, pointBox, pointBoxHandles, pointBoxHit, resizePointNetwork, rotatePointNetwork, translatePointNetwork, type PointBounds } from "./pointBox";
import { lassoSelectPathPoints, type LassoOperation } from "./vectorLasso";
import { layersAt } from "./selectSame";
import { canvasClickTarget, drillChild, marqueeCollect, rotationHandleHit } from "./canvasSelection";
import { rememberImage, hydrateNodes } from "../engine/assets";
import { resizeGroupMembers, rotateGroupMembers, rotateAboutOrigin, wrapRotationDeg } from "./scaleModel";
import {
  erasePath,
  shapePoly,
  simplifyPath,
  smoothPath,
  vertexDegree,
  insertPointOnPath,
  projectPointOnSegment,
  splitPathAtPoint,
  cutPathWithLine,
  computeConnectorNoodle,
  pathToVectorNetwork,
  balanceLines,
  cornerPinPoints,
  cornerRadiiOf,
  hasCornerSmoothing,
  roundRectRadii,
  pathBounds,
  smoothHandlesForPoint,
  fillNetworkRegionAtPoint,
  outlineVariableStroke,
  outlineWalk,
  walkAt,
  walkNearest,
  type OutlineWalk,
  widthProfileStations,
  widthStationAt,
  projectToPath,
} from "../engine/geometry";
import {
  MAX_WIDTH_MULTIPLIER,
  brushStrokePasses,
  dashArray,
  dynamicWobble,
  dashOffset,
  normalizeWidthProfile,
  paintedStrokeAlign,
  sampleVariableWidth,
  strokePaints,
  sideCones,
  sideWidths,
  sidesSupported,
  usesVariableWidth,
  variableWidthBlockReason,
} from "../engine/strokeModel";
import { interpolateMatchingLayers, solveEasing, applyInterpolatedFrame } from "../engine/smartAnimate";
import {
  roundBox,
  snapCandidates,
  snapMove,
  snapResize,
  smartSelectionGaps,
  wantsPixelSnap,
  type Box,
  type GapBadge,
  type Guide,
} from "../engine/snapping";
import { dropMaskNeeds, fillStyle, gradTarget, mixHex, paintDropShadowsMasked, paintExtraStrokes, paintFill, paintImageFill, paintInnerShadows, paintStack, patternStrokeStyle, spreadApplies, strokeCanvasMiterLimit, paintsAnyFill, partitionMaskRuns, reduceMaskAlpha, sectionsFirst, processImage, rotatedImageSize } from "../engine/paint";
import { withPreviewEffect } from "./effectModel";
import { patternSourceNode, setPatternLookup } from "../engine/pattern";
import { cropFullExtent, cropHandleRects, dragCropHandle, initialCropRect, layerToImage, moveCrop, type CropHandle, type CropRect } from "./cropModel";
import { coverCrop, normalizeCropRect } from "../engine/paint";
import { registerPenFinisher } from "./penDraft";
import { registerConnDismiss } from "./connSelection";
import { clampZoom, normalizeWheelDelta, wheelZoomFactor } from "../engine/view";
import { Rulers } from "./Rulers";
import { Guides } from "./Guides";
import { Minimap } from "./Minimap";
import { Comments } from "./Comments";
import { useTheme } from "./theme";
import { hasMixedTextSpans, styledTextRows, truncateStyledRows } from "./textLayout";
import { rememberTextRange, resolvedTextSpans, spansAfterTextEdit, styleTextRange } from "./textSpans";
import {
  emojiCompletions,
  emojiQueryAt,
  fontFamilyStack,
  insertEmoji,
  smartConvert,
  directionOf,
} from "../engine/textInput";
import { smartSymbolsEnabled } from "./smartSymbols";
import { applyTextCase, canvasTextFont, effectiveLineHeight, firstRowInset, fitLineCount, fontMetricRatios, hugHeight, hugSize, indentOf, invalidateTextMeasureCache, listCounters, listGutter, listLayout, listLevelOf, measureCached, overlayRowShift, paraListStyle, paraWrapOf, textMetrics, valignApplies, wrapLines } from "./textLayout";
import { canvasBlend, cssRgba, eyedropArmed, getEyedropModel, isNone, parseHex, readableLabel, rgbToHsl, rgbToHsv, setRenderColorProfile, getCanvas2dContext, takeEyedrop, toHex, type EyedropModel } from "./color";
import { eyedropSourceForNode } from "./eyedropper";
import { ContextMenu, canvasMenu, isGroupNode, runMenu } from "./ContextMenu";
import type { ImportedNode } from "../engine/svgImport";
import { importSvg, importSketch, importFig } from "../engine/wasmBridge";
import { importFigContainer } from "../engine/figImport";
import {
  markPasteEvent,
  parseClipboard,
  pasteInPlace,
  readSystemClipboard,
  type ClipPayload,
} from "../engine/clipboard";
import { toast } from "./toast";
import { bendReadiness, BREAK_MIRROR_MODE, effectiveMirrorMode, anchorIndexAt, addPointTargetAt, ADD_POINT_TOL_PX, VERTEX_PRIORITY_PX } from "./vectorEdit";
import { Icon } from "./icons";
import { clampBadge, zoomAtPoint, zoomToRect } from "./zoom";
import { modalOpen } from "./escape";
import { getNudgePrefs } from "./nudgePrefs";
import { alignKey, flowGapLine, flowInsertIndex, wrapLines as flowWrapLines, wraps } from "../engine/layout";
import { ContextToolbar, XButton } from "./x-ui";
import { addAutoLayout, removeAutoLayout } from "./layoutActions";
import { align } from "./inspector";
import { readCanvasChrome, withAlpha } from "./canvasChrome";
import { dismissEmptyCanvasHint, emptyCanvasHintDismissed } from "./firstRun";

/** Snap radius in screen pixels; divided by zoom to get world tolerance. */
const SNAP_PX = 6;
/** Eraser brush radius, in screen pixels. */
const ERASER_PX = 10;

/**
 * Effective closed flag for vector editing. Basic shapes carry no path (and
 * closed:false) until the first edit, but a rect/ellipse/poly/star is
 * semantically a loop — only lines and arrows are open.
 */
function effClosed(n: { path: unknown[]; closed?: boolean; kind?: string }): boolean {
  if (n.path.length) return !!n.closed;
  return n.kind !== "line" && n.kind !== "arrow";
}

/** What a "+" hover is pointing at: the node being edited and where the new
 *  anchor would land, in that node's LOCAL space (so the painted marker rides
 *  the node's own rotation/flip with it). */
interface AddPointPreview {
  id: string;
  x: number;
  y: number;
  segIndex: number;
}

/**
 * Kinds a double-click converts into an editable path — Figma's Enter gesture on
 * a shape, where `rect`/`ellipse`/`poly`/`star` become a `vector` in place and a
 * childless `boolean` is baked down first. The list has two readers: the entry
 * itself, and the press-standing-on-an-anchor test that stops the selection box's
 * edge sizing from stealing that gesture. One const, so they cannot drift.
 */
const PATH_ENTRY_KINDS: NodeKind[] = [
  "vector", "boolean", "rect", "ellipse", "poly", "star", "line", "arrow",
];
/**
 * The same set for the Pen tool's "+" hover. A `boolean` is left out because the
 * pen's own click branch refuses it: the preview may never promise a wider set of
 * layers than the click is willing to edit.
 */
const PEN_POINT_KINDS: NodeKind[] = [
  "vector", "rect", "ellipse", "poly", "star", "line", "arrow",
];

/**
 * Figma's "add an anchor to an existing path" hit rule, in one place.
 *
 * The preview and the click are two ends of the same gesture, so they measure it
 * the same way: 10 screen px to the segment, a vertex inside the press's own grab
 * radius (`VERTEX_PRIORITY_PX`, 8 in a point edit and 10 for the pen) outranks the
 * insert, and a locked layer, an instance member or a branched network is refused
 * because the click refuses it too — a "+" you cannot click is a lie.
 */
function vectorAddPointTarget(
  root: XNode,
  id: string,
  local: { x: number; y: number },
  zoom: number,
  opts: { edited: boolean; vertexPx: number },
): AddPointPreview | null {
  const node = worldPos(root, id)?.node;
  if (!node || node.locked || !node.visible) return null;
  if (isEffectivelyLocked(root, node.id) || isInstanceMember(root, node.id)) return null;
  if (!opts.edited) {
    // The pen reaches an unedited path's segments the same way; a basic shape
    // first converts to an editable path on the insert, exactly as it does on
    // Enter, so it is armed too — but only for the kinds the click branch takes.
    if (!PEN_POINT_KINDS.includes(node.kind)) return null;
  }
  // A branched/compound network's `path` is one run of it, so an insert there
  // would drop the rest — and the click says so rather than drawing one.
  if (topologyEditBlocked(node)) return null;
  const pts = node.path.length ? node.path : shapePoly(node);
  const at = addPointTargetAt(pts, local, effClosed(node), zoom, opts.vertexPx);
  return at ? { id: node.id, ...at } : null;
}
/** RDP tolerance for freehand strokes, in screen pixels. */
const PENCIL_TOLERANCE_PX = 2;

/* Canvas chrome — everything these canvases *paint* over the document — is no
 * longer literals in this file. It lives in styles.css as the `--cv-*` role
 * family and is read once per paint through canvasChrome.ts (FR-U2), so the
 * canvas follows the theme and the sheet stays the only place a colour is
 * chosen. What remains below is DOCUMENT ink: values written into the file
 * itself. Those must not follow the theme, or a saved document — and its SVG
 * export — would change colour with the viewer's appearance setting. */
/** A new Slice's dashed stroke, written into the layer on creation. */
const DOC_SLICE_STROKE = "#10b981";
/** Paint-bucket defaults: a region's fill when the node has none, and the
 *  brand emerald it gets when its fill was hidden. Both land in the document. */
const DOC_FILL_NONE = "#d9d9d9";
const DOC_FILL_BRAND = "#10b981";

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

/** Ruler guides in world positions for snapping; frame-level guides resolve
 *  against their frame, stale ones (frame gone) drop out. */
function worldGuides(root: XNode, guides: RulerGuide[]): { axis: "x" | "y"; at: number }[] {
  return guides.flatMap((g) => {
    if (!g.frameId) return [{ axis: g.axis, at: g.at }];
    const wp = worldPos(root, g.frameId);
    if (!wp) return [];
    return [{ axis: g.axis, at: (g.axis === "x" ? wp.x : wp.y) + g.at }];
  });
}

/** Fields that take `Space` as a character, so the canvas must not steal it.
 *
 *  The three prose surfaces in the app are the on-canvas text editor, the file
 *  name, and a layer rename — all `textarea`/contenteditable/`input` with a
 *  textual type. The Inspector's numeric scrub fields are the opposite case:
 *  their value is a number (`x-num-input`, no `type`, so the DOM reports
 *  "text"), Space can never be part of it, and while one of them held the caret
 *  the canvas used to refuse the key outright — the pan died and the browser
 *  re-activated whatever panel control was focused instead. */
function keepsSpaceKey(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  if (el.classList?.contains("x-num-input")) return false;
  const type = (el as HTMLInputElement).type;
  return (
    type === "text" ||
    type === "search" ||
    type === "email" ||
    type === "url" ||
    type === "password" ||
    type === "tel"
  );
}

function kindOf(t: Tool): NodeKind | null {
  if (t === "section") return "section";
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
        | "vecResize"
        | "vecLasso"
        | "bend"
        | "vecCut"
        | "widthPt"
        | "grad"
        | "gradStop"
        | "gradMid"
        | "multiResize"
        | "multiRotate"
        | "autoPad"
        | "pathStart"
        | "autoGap"
        | "smartGap"
        | "protoConnect"
        | "starRatio"
        | "starRadius"
        | "starCount"
        | "polyRadius"
        | "polyCount"
        | "radius"
        | "arc"
        | "rotOrigin"
        | "crop"
        | "cropMove"
        | "cropRotate"
        | "cropScale";
      /** Zoom-tool drag: the create block zooms to the rect instead of
       *  committing a node. */
      zoom?: boolean;
      point?: number;
      segIndex?: number;
      handle?: "in" | "out" | "start" | "g" | "h" | "f";
      /** Gradient-handle drag: which `fills` index the handles grabbed, -1 for the base fill. */
      gindex?: number;
      /** An authored intermediate stop on that ramp. Keeping it bounded by its
       * neighbours means it retains its identity while it is dragged instead
       * of accidentally becoming a different stop after a sort. */
      gradStop?: number;
      gradStopMin?: number;
      gradStopMax?: number;
      /** The stop-pair whose midpoint handle is being dragged: between stops
       *  i and i+1 on the ramp. */
      gradMid?: number;
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
      gapAxis?: "gap" | "gapCross";
      /** Smart-selection gap handle drag: the live gap value and the pointer
       *  position the drag started from (both world coordinates). */
      smartGap?: number;
      smartSX?: number;
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
      /** Crop drag: the handle being pulled, and the pointer's last local
       *  point for the move (reposition) variant. */
      cropHandle?: CropHandle;
      cropScaleEdge?: "n" | "e" | "s" | "w";
      cropLX?: number;
      cropLY?: number;
      /** Crop drag: the rect at drag start; every move recomputes from it. */
      cropStart?: CropRect;
      duped?: boolean;
      /** Selection when a ⇧-marquee started: the band unions with this, so
       *  shrinking the band lets go of layers instead of accumulating them. */
      sel0?: string[];
      axis?: "x" | "y" | null;
      /** Combined selection bounds at drag start (group transforms). */
      bounds?: { x: number; y: number; w: number; h: number };
      origs?: MultiOrigin[];
      origPts?: PathPoint[];
      /** Run 23 width-point drag: the profile at press (live patches derive
       *  from it so every move is delta-from-start) and the selected indices
       *  moved together. */
      wOrig?: VariableWidthPoint[];
      wSel?: number[];
      origNetwork?: VectorNetwork;
      networkIndices?: number[];
      /** Freeform Lasso path and the modifier chosen at pointer-down. */
      lassoPoints?: { x: number; y: number }[];
      lassoOperation?: LassoOperation;
      /** Live rotation readout/cursor position. */
      rotationDeg?: number;
      currentX?: number;
      currentY?: number;
      /** Space temporarily translates points while preserving the in-flight
       * resize/rotation gesture as a fresh baseline on key-up. */
      spaceState?: { network: VectorNetwork; bounds: PointBounds; dx: number; dy: number; lastX: number; lastY: number };
      startAngle?: number;
      origRotation?: number;
      cx?: number;
      cy?: number;
    };

/** Drop selected descendants whose selected ancestor already carries them. */
function transformSelectionRoots(root: XNode, ids: string[]): string[] {
  const wanted = new Set(ids), roots: string[] = [];
  const walk = (n: XNode, carried: boolean) => {
    const selected = wanted.has(n.id);
    if (selected && !carried) roots.push(n.id);
    for (const c of n.children) walk(c, carried || selected);
  };
  walk(root, false);
  return roots;
}

/** Snapshot every selected node's world + local box before a group transform. */
function multiOrigins(root: XNode, ids: string[]): MultiOrigin[] {
  const out: MultiOrigin[] = [];
  for (const id of transformSelectionRoots(root, ids)) {
    const wp = worldPos(root, id);
    const own = find(root, id);
    if (!wp || !own || isEffectivelyLocked(root, id) || isInstanceMember(root, id)) continue;
    out.push({
      id,
      x: wp.x,
      y: wp.y,
      w: wp.node.w,
      h: wp.node.h,
      rotation: own.rotation,
      lx: own.x,
      ly: own.y,
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

/**
 * The arc controls of an ellipse in screen space, in the order the pointer path
 * tests them (Figma help 360040450173, "Arc tool: create arcs, semi-circles,
 * and rings"): the **Sweep** handle at the arc's end, the **Start** handle -
 * "which has a dot inside it" - once the sweep has opened a gap, and the
 * **Ratio** handle at `endingAngle * innerRadius`, which is the centre of a pie
 * ("The Ratio handle at the center of the circle allows you to change the
 * circle to a ring"). One owner for paint and hit-test, so the dot a user sees
 * is the dot the pointer grabs.
 */
function arcHandlePoints(
  node: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): { kind: "out" | "start" | "in"; x: number; y: number }[] {
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;
  const rx = sw / 2;
  const ry = sh / 2;
  const d = node.arcData;
  const sa = d?.startingAngle ?? 0;
  const ea = d?.endingAngle ?? Math.PI * 2;
  const ir = Math.max(0, Math.min(0.99, d?.innerRadius ?? 0));
  const gap = !!d && Math.abs(ea - sa) < Math.PI * 2 - 0.001;
  const out: { kind: "out" | "start" | "in"; x: number; y: number }[] = [
    { kind: "out", x: cx + Math.cos(ea) * rx, y: cy + Math.sin(ea) * ry },
  ];
  if (gap) out.push({ kind: "start", x: cx + Math.cos(sa) * rx, y: cy + Math.sin(sa) * ry });
  if (gap || ir > 0) out.push({ kind: "in", x: cx + Math.cos(ea) * rx * ir, y: cy + Math.sin(ea) * ry * ir });
  return out;
}

/** Paint those controls. The caller has already applied the node's transform. */
function paintArcHandles(
  ctx: CanvasRenderingContext2D,
  node: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  ink: string,
  sel: string,
) {
  for (const h of arcHandlePoints(node, sx, sy, sw, sh)) {
    ctx.fillStyle = ink;
    ctx.strokeStyle = sel;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (h.kind === "start") {
      // "The Start handle (which has a dot inside it)".
      ctx.beginPath();
      ctx.arc(h.x, h.y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = sel;
      ctx.fill();
    }
  }
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
  const capturedRange = useRef<{ id: string; start: number; end: number } | null>(null);
  const captureRange = (el: HTMLTextAreaElement, id: string) => {
    const { selectionStart: start, selectionEnd: end } = el;
    const range = start < end ? { id, start, end } : null;
    capturedRange.current = range;
    rememberTextRange(engine, range);
  };
  // Mousedown lands before blur: when editing text A and pressing on text B,
  // the intercept below stashes B here so the blur commits A and opens B
  // instead of closing the editor outright.
  const editSwitch = useRef<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const pointerClient = useRef({ x: 0, y: 0 });
  // Mirrors the ref so the grab cursor flips the moment Space lands; the ref
  // alone would leave the cursor stale until the next render.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const imgs = useRef(new Map<string, HTMLImageElement>());
  /** Resolve an image source to a loaded element, kicking off the load and
   *  repainting on arrival when it is not there yet. */
  /** Crop tool: the layer being cropped (its rect patches live, one undo
   *  per gesture), plus the pre-tool rect for Esc and a dirty flag. */
  const [cropId, setCropId] = useState<string | null>(null);
  const [cropAspect, setCropAspect] = useState<"image" | "1:1" | "4:3" | "16:9" | "3:2" | "free">("image");
  const [cropZoom, setCropZoom] = useState(100);
  const cropZoomBase = useRef<CropRect | undefined>(undefined);
  const cropOrig = useRef<CropRect | undefined>(undefined);
  const cropOrigSize = useRef<{ w: number; h: number } | undefined>(undefined);
  const cropOrigRotation = useRef<number | undefined>(undefined);
  const cropOrigFit = useRef<ImageFit | undefined>(undefined);
  const cropDirty = useRef(false);
  /** The whole session — the mode switch, every drag, the apply — folds into
   *  ONE undo entry (Figma's "click or Enter applies, one undo reverts the
   *  crop"): a begin at entry, an end at every exit, refs so stale closures
   *  and double exits cannot unbalance the engine's group stack. */
  const cropSession = useRef(false);
  const cropIdRef = useRef<string | null>(null);
  const endCropSession = () => {
    if (cropSession.current) {
      cropSession.current = false;
      engine.dispatch({ type: "end" });
    }
  };
  /** Apply the crop: close the tool keeping the edits, ending the session. */
  const applyCrop = () => {
    cropIdRef.current = null;
    setCropId(null);
    cropOrigSize.current = undefined;
    cropOrigRotation.current = undefined;
    cropZoomBase.current = undefined;
    setCropZoom(100);
    setCropAspect("image");
    endCropSession();
  };
  /** Place-image queue: sources picked from the file dialog, placed one per
   *  click (a click on a shape fills it instead of adding a layer). */
  const [placing, setPlacing] = useState<{ srcs: { src: string; name: string }[]; i: number } | null>(null);
  // Pattern fills resolve their source layer live, from any page, so an
  // edit to the source repaints every layer that repeats it.
  setPatternLookup((id) => {
    const s = engine.snapshot();
    for (const pg of s.pages) {
      const hit = find(pg.root, id);
      if (hit) return hit;
    }
    return undefined;
  });
  const imgOf = (src: string) => {
    let im = imgs.current.get(src);
    if (!im && src) {
      im = new Image();
      im.src = src;
      im.onload = () => engine.dispatch({ type: "select", ids: engine.snapshot().selection });
      imgs.current.set(src, im);
    }
    return im && im.complete && im.naturalWidth ? im : undefined;
  };
  /** Enter the crop tool on an image layer: select it, switch its mode to
   *  Crop, and remember the pre-tool rect (and fill mode) for Esc. The whole
   *  session opens one history group so apply/cancel is a single undo step. */
  const enterCrop = (id: string) => {
    const now = engine.snapshot();
    const n = find(now.pages[now.page].root, id);
    if (!n || (!n.imageSrc && n.fillType !== "image")) return;
    if (n.fillType === "image" && !n.imageSrc) return;
    if (cropSession.current) {
      // Re-entering the same layer keeps the open session (and its snapshot);
      // a different target applies the first before opening the second.
      if (cropIdRef.current === id) return;
      applyCrop();
    }
    cropOrig.current = n.imageCrop ? { ...n.imageCrop } : undefined;
    cropOrigSize.current = { w: n.w, h: n.h };
    cropOrigRotation.current = n.imageRot ?? 0;
    cropZoomBase.current = n.imageCrop ? { ...n.imageCrop } : undefined;
    setCropZoom(100);
    setCropAspect("image");
    cropOrigFit.current = n.imageFit;
    cropDirty.current = false;
    cropSession.current = true;
    engine.dispatch({ type: "begin" });
    if (n.imageFit !== "crop") engine.dispatch({ type: "patch", id, patch: { imageFit: "crop" } });
    engine.dispatch({ type: "select", ids: [id] });
    if (n.imageSrc) imgOf(n.imageSrc);
    cropIdRef.current = id;
    setCropId(id);
  };
  /** Leave the crop tool, writing the pre-tool rect and fill mode back inside
   *  the session — the revert folds into the group, so Esc leaves no entry. */
  const cancelCrop = () => {
    const id = cropIdRef.current;
    if (id && cropDirty.current) {
      engine.dispatch({
        type: "patch",
        id,
        patch: {
          imageCrop: cropOrig.current,
          ...(cropOrigSize.current ?? {}),
          ...(cropOrigRotation.current != null ? { imageRot: cropOrigRotation.current } : {}),
        },
      });
    }
    if (id && cropOrigFit.current !== undefined) {
      const now = engine.snapshot();
      const cur = find(now.pages[now.page].root, id);
      if (cur && cur.imageFit !== cropOrigFit.current) {
        engine.dispatch({ type: "patch", id, patch: { imageFit: cropOrigFit.current } });
      }
    }
    applyCrop();
  };
  useEffect(() => {
    const onCropEvent = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (id) enterCrop(id);
    };
    const onPlaceEvent = () => {
      // A cancelled image-tool click leaves a stale point behind; the menu
      // path queues everything instead of landing the first on it.
      pendingImage.current = null;
      fileRef.current?.click();
    };
    window.addEventListener("x-native-crop-image", onCropEvent);
    window.addEventListener("x-native-place-image", onPlaceEvent);
    return () => {
      window.removeEventListener("x-native-crop-image", onCropEvent);
      window.removeEventListener("x-native-place-image", onPlaceEvent);
    };
  }, []);
  /** Processed image dimensions for the crop tool (rotation-aware), or
   *  null while the source is still loading. */
  const cropImageDims = (cn: XNode) => {
    const im = cn.imageSrc ? imgs.current.get(cn.imageSrc) : undefined;
    if (!im || !im.complete || !im.naturalWidth) return null;
    const size = rotatedImageSize(im.naturalWidth, im.naturalHeight, cn.imageRot ?? 0);
    return { iw: size.w, ih: size.h };
  };
  const resetCrop = () => {
    if (!cropId) return;
    const root = engine.snapshot().pages[engine.snapshot().page].root;
    const cn = find(root, cropId);
    const dims = cn && cropImageDims(cn);
    if (!cn || !dims) return;
    cropZoomBase.current = undefined;
    setCropZoom(100);
    cropDirty.current = true;
    engine.dispatch({ type: "patch", id: cropId, patch: { imageCrop: undefined, w: dims.iw, h: dims.ih } });
  };
  const setCropZoomValue = (value: number) => {
    if (!cropId) return;
    const root = engine.snapshot().pages[engine.snapshot().page].root;
    const cn = find(root, cropId);
    const dims = cn && cropImageDims(cn);
    if (!cn || !dims) return;
    const current = cn.imageCrop ? normalizeCropRect(cn.imageCrop) : coverCrop(dims.iw, dims.ih, cn.w, cn.h);
    const base = cropZoomBase.current ?? current;
    cropZoomBase.current = { ...base };
    const scale = 100 / Math.max(100, value);
    const w = Math.min(1, base.w * scale);
    const h = Math.min(1, base.h * scale);
    const cx = base.x + base.w / 2;
    const cy = base.y + base.h / 2;
    const rect = normalizeCropRect({ x: cx - w / 2, y: cy - h / 2, w, h });
    setCropZoom(Math.max(100, Math.min(400, value)));
    cropDirty.current = true;
    engine.dispatch({ type: "patch", id: cropId, patch: { imageCrop: rect } });
  };
  const normalizedCropAspect = (dims: { iw: number; ih: number }) => {
    if (cropAspect === "image") return 1;
    if (cropAspect === "free") return undefined;
    const [w, h] = cropAspect.split(":").map(Number);
    // Crop model geometry is image-normalized. Convert the requested pixel
    // aspect ratio into normalized width/height for this source image.
    return (w / h) * (dims.ih / dims.iw);
  };
  // A selection that leaves the cropped layer applies the crop.
  useEffect(() => {
    if (cropId && !snap.selection.includes(cropId)) applyCrop();
  }, [snap.selection]);
  // Never leave the engine grouping on an unmount mid-session: the stack
  // would swallow every later edit into one entry.
  useEffect(() => {
    return () => {
      endCropSession();
    };
  }, [engine]);
  // Smart-selection handles: recompute the mid-gap badges whenever the
  // selection or the page geometry changes, so a nudged layer makes the run
  // stop matching and the handles disappear, exactly as the article's
  // "all layers must be an equal distance apart" rule requires.
  useEffect(() => {
    const root = snap.pages[snap.page].root;
    const boxes: Box[] = [];
    for (const id of snap.selection) {
      const wp = worldPos(root, id);
      if (!wp || isEffectivelyLocked(root, id) || isInstanceMember(root, id)) continue;
      const b = nodeVisualBounds(wp);
      boxes.push({ id, x: b.x, y: b.y, w: b.w, h: b.h });
    }
    const next = boxes.length >= 2 ? smartSelectionGaps(boxes) : [];
    // Returning the previous array when nothing moved keeps this effect from
    // re-rendering the canvas on every unrelated dispatch.
    setSmartGaps((prev) =>
      prev.length === next.length &&
      prev.every((b, i) => b.axis === next[i].axis && b.at === next[i].at && b.cross === next[i].cross && b.size === next[i].size)
        ? prev
        : next,
    );
    // `snap` itself is the dependency: the engine keeps the same `pages`
    // reference across a dispatch and bumps `treeRev`, so a narrower list
    // would leave the handles stale while a layer moves.
  }, [snap]);
  // Enter applies, Escape reverts, while cropping or placing. Keystrokes
  // aimed at a field belong to the field, not the tool.
  useEffect(() => {
    if (!cropId && !placing) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (cropId) cancelCrop();
        if (placing) {
          setPlacing(null);
          engine.dispatch({ type: "setTool", tool: "select" });
        }
      } else if (e.key === "Enter" && cropId) {
        e.preventDefault();
        e.stopPropagation();
        applyCrop();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [cropId, placing]);
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const eyedropPixel = useRef<{ x: number; y: number; hex: string } | null>(null);
  const [eyedropModel, setEyedropModelState] = useState<EyedropModel>(getEyedropModel);
  useEffect(() => {
    const onModel = (event: Event) => {
      const model = (event as CustomEvent<EyedropModel>).detail;
      if (model) setEyedropModelState(model);
    };
    window.addEventListener("x-eyedrop-model", onModel);
    return () => window.removeEventListener("x-eyedrop-model", onModel);
  }, []);
  const [edit, setEdit] = useState<{ id: string; text: string; also?: string[] } | null>(null);
  /** A URL pasted in place becomes a linked range (360045942953), committed
   *  with the edit on blur so the runs keep their text offsets. */
  const linkMarkRef = useRef<{ start: number; end: number; url: string } | null>(null);
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
  const [vecSubTool, setVecSubTool] = useState<"select" | "bend" | "paint" | "shapeBuilder" | "eraser" | "lasso" | "cut">("select");
  /** Run 22 (vector cut): the blade preview line, world coords, while the
   *  cut drags across the path. */
  const [cutLine, setCutLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[]>([]);
  useEffect(() => {
    if (!vecEdit) {
      setVecSubTool((tool) => tool === "select" ? tool : "select");
      setLassoPath((path) => path.length ? [] : path);
    }
  }, [vecEdit]);
  const [draft, setDraft] = useState<PathPoint[]>([]);
  // LP-U4: the dismissal outlives the session (firstRun.ts), so the card is
  // shown once per visitor rather than once per mount.
  const [firstRun, setFirstRun] = useState(() => !emptyCanvasHintDismissed());
  const [ghost, setGhost] = useState<PathPoint | null>(null);
  const [hoverId, setHoverId] = useState("");
  /** Run 23 — variable-width interaction: the pointer projected onto the
   *  selected stroke (pink preview handle, ringed over an existing width
   *  point), the selected width-point indices, and a press waiting to become
   *  an add — validated on release so a drag still moves the layer. */
  const [widthHover, setWidthHover] = useState<{
    id: string;
    t: number;
    x: number;
    y: number;
    onPoint: number | null;
  } | null>(null);
  const [widthSel, setWidthSel] = useState<number[]>([]);
  const pendingWidth = useRef<{ sx: number; sy: number; id: string; t: number; x: number; y: number } | null>(null);
  /** Interactive width points are for plain single-path solid vectors: the
   *  shared variableWidthBlockReason refuses dashes/branches/pattern/brush,
   *  lines and arrows stay inspector-only (their whole box IS the stroke, so
   *  a press along the centerline must keep dragging the layer), and locked,
   *  rotated, or invisible strokes take no handles either. */
  const widthEditOk = (n: XNode): boolean =>
    n.kind === "vector" &&
    n.path.length >= 2 &&
    strokePaints(n) &&
    !variableWidthBlockReason(n) &&
    !n.rotation &&
    !n.flipH &&
    !n.flipV &&
    !n.locked;
  // Changing or clearing the selection drops the station selection with it.
  useEffect(() => {
    if (!widthSel.length && !widthHover) return;
    const id = snap.selection.length === 1 ? snap.selection[0] : null;
    if (!id) {
      if (widthSel.length) setWidthSel([]);
      if (widthHover) setWidthHover(null);
    } else if (widthHover && widthHover.id !== id) setWidthHover(null);
  }, [snap.selection, widthSel.length, widthHover]);
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
  /** Phase 10: eraser stroke collector for WASM finalization. */
  const eraserPath = useRef<{ points: [number, number][]; targetId: string | null } | null>(null);

  /** Phase 10: Commit a pen/pencil path through WASM and MemoryEngine.
   *  Called on pen draft finalization (Enter/Escape/close-click) and pencil mouseup. */
  const commitPathWasm = useCallback(
    (points: PathPoint[], closed: boolean) => {
      engine.dispatch({ type: "addPath", points, closed });
      if (points.length < 2) return;
      const snapNow = engine.snapshot();
      const root = snapNow.pages[snapNow.page].root;
      const parentId = root.id;
      const isPencil = snapNow.tool === "pencil";
      const tol = PENCIL_TOLERANCE_PX / snapNow.zoom;
      const xyPoints = points.map((p) => ({ x: p.x, y: p.y }));
      void (async () => {
        try {
          const { wasmCommitPenPath, wasmSmoothPencilPath } = await import("../engine/wasmDrawing");
          if (isPencil) {
            await wasmSmoothPencilPath(root, parentId, xyPoints, tol);
          } else {
            await wasmCommitPenPath(root, parentId, xyPoints);
          }
        } catch {
          // WASM unavailable — TS path already applied synchronously
        }
      })();
    },
    [engine],
  );
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
  /** §23 PT-005: a while-hovering navigation's way home (node, origin frame,
   *  destination); leaving the hotspot returns unless a Mouse-leave ran. */
  const hoverReturn = useRef<{ nodeId: string; fromFrame: string; destId: string } | null>(null);
  /** Present-mode drag origin for the onDrag trigger; cleared on pointer-up. */
  const dragIx = useRef<{ x: number; y: number; id: string; fired: boolean } | null>(null);
  /** Cursor implied by whatever selection chrome is under the pointer. */
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  /* Keeps the rotation origin out of the way until `⌥R` asks for it. */
  const [rotTarget, setRotTarget] = useState(false);
  /** Where a click would insert an anchor on the path under the pointer (Figma's
   *  "+" pen state). Node-local coordinates, in the edited node's space. */
  const [addPt, setAddPt] = useState<AddPointPreview | null>(null);
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
  /** Links (360045942953): the "Create link" input box above the selection. */
  const [linkInput, setLinkInput] = useState<{ left: number; top: number; id: string; start?: number; end?: number } | null>(null);
  const [linkHover, setLinkHover] = useState<{ left: number; top: number; url: string } | null>(null);
  /** Emoji `:code` completion (360039957174): the open picker while a
   *  `:name` fragment sits at the caret. */
  const [emojiPick, setEmojiPick] = useState<{ left: number; top: number; start: number; query: string } | null>(null);
  const emojiApply = (_code: string, emoji: string) => {
    if (!emojiPick) return;
    const next = insertEmoji(edit?.text ?? "", emojiPick.start, emojiPick.start + emojiPick.query.length + 1, emoji);
    if (edit) setEdit({ ...edit, text: next.text });
    setEmojiPick(null);
  };
  useEffect(() => {
    const open = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      if (d) setLinkInput({ left: d.left, top: d.top, id: d.id, start: d.start, end: d.end });
    };
    window.addEventListener("x-native:link-input", open);
    return () => window.removeEventListener("x-native:link-input", open);
  }, []);
  /** Viewport size, tracked so the ruler overlay can size its own canvas. */
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fontRevision, setFontRevision] = useState(0);
  const requestedFonts = useRef(new Set<string>());
  const canvasMounted = useRef(true);
  useEffect(() => {
    canvasMounted.current = true;
    return () => { canvasMounted.current = false; };
  }, []);
  /** Live smart-guide overlay, produced by the snapping pass during a drag. */
  const [guides, setGuides] = useState<Guide[]>([]);
  const [gapBadges, setGapBadges] = useState<GapBadge[]>([]);
  /** Smart-selection gap handles: for a 1D selection of equal-spaced layers,
   *  the mid-gap badges a drag can grab (Figma help 360040450233). Separate
   *  from `gapBadges`, which is move-snapping feedback and only exists during
   *  a drag. */
  const [smartGaps, setSmartGaps] = useState<GapBadge[]>([]);
  /** Live drop target during a move drag: the frame outline plus, for a linear
   *  flow, the blue insertion line - all in world coordinates. */
  const [dropHint, setDropHint] = useState<{
    fx: number;
    fy: number;
    fw: number;
    fh: number;
    line: { horiz: boolean; at: number; from: number; to: number } | null;
  } | null>(null);
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
  /** §23 PT-016: copied connection rows (⌘C on a noodle); a layer copy/cut clears it. */
  const connClipboard = useRef<Interaction[]>([]);
  /** Static snap targets, captured once at drag start so they never shift mid-drag. */
  const snapTargets = useRef<Box[]>([]);
  const { theme, chromePref } = useTheme();
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
          const s = engine.snapshot();
          const target = worldPos(s.pages[s.page].root, ix.destination);
          if (target) {
            const toX = -target.x * s.zoom + 120;
            const toY = -target.y * s.zoom + 120;
            // §23 PT-011: Scroll-to honors the animation (Figma: instant or
            // eased) instead of always jumping.
            if (!ix.animation || ix.animation === "instant") {
              engine.dispatch({ type: "setPan", x: toX, y: toY });
            } else {
              const fromX = s.panX;
              const fromY = s.panY;
              const dur = ix.duration || 250;
              const start = performance.now();
              const tick = () => {
                const t = Math.min(1, Math.max(0, (performance.now() - start) / dur));
                const k = solveEasing(ix.easing || "easeOut", t);
                engine.dispatch({ type: "setPan", x: fromX + (toX - fromX) * k, y: fromY + (toY - fromY) * k });
                if (t < 1) requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }
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
          // §23 PT-003: Swap retains the open overlay's settings (Figma) and
          // never touches history; from a plain frame it navigates instead.
          const open = engine.snapshot().activeOverlay;
          if (!open) {
            engine.dispatch({ type: "presentGo", id: ix.destination });
          } else {
            engine.dispatch({
              type: "openOverlay",
              id: ix.destination,
              position: open.position,
              closeOutside: open.closeOutside,
              backdrop: open.backdrop,
              backdropColor: open.backdropColor,
            });
          }
        } else if (ix.action === "closeOverlay") {
          engine.dispatch({ type: "closeOverlay" });
        } else if (ix.action === "setVariable" && ix.variableId) {
          const s = engine.snapshot();
          const vars = s.variables ?? [];
          const cur = resolveVariable(vars, s.variableCollections ?? [], s.activeModes ?? {}, ix.variableId);
          if (cur && !cur.broken) {
            let nextVal: string | number | boolean = ix.variableValue !== undefined ? ix.variableValue : cur.value;
            // §23 PT-017: =expressions evaluate here too, like the player's
            // own fallback path already did.
            if (typeof nextVal === "string" && nextVal.startsWith("=")) {
              const res = evaluateExpression(nextVal.slice(1), {
                vars: resolveAllForMode(vars, s.variableCollections ?? [], s.activeModes ?? {}),
              });
              if (!res.error && res.value !== undefined) nextVal = res.value;
            }
            if (ix.variableOp === "increment" && typeof cur.value === "number") nextVal = cur.value + 1;
            else if (ix.variableOp === "decrement" && typeof cur.value === "number") nextVal = cur.value - 1;
            else if (ix.variableOp === "toggle" && typeof cur.value === "boolean") nextVal = !cur.value;
            engine.dispatch({ type: "patchVariable", id: ix.variableId, patch: { value: nextVal } });
          }
        } else if (ix.action === "setVariableMode" && ix.variableCollectionId && ix.variableModeId) {
          // §23 PT-012: Figma's Set-variable-mode action.
          engine.dispatch({ type: "setActiveMode", collectionId: ix.variableCollectionId, modeId: ix.variableModeId });
        } else if (ix.action === "setVariant" && ix.variantName && sourceId) {
          // Interactive components: swap the interaction's own instance.
          engine.dispatch({ type: "setVariant", id: sourceId, name: ix.variantName });
        }
      };
      if (reduced || ix.animation === "instant" || !ix.animation || ix.action === "openUrl" || ix.action === "scrollTo" || ix.action === "setVariable" || ix.action === "setVariableMode" || ix.action === "setVariant") {
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
      // §23 PT-005: while-hovering navigations remember where they came from
      // (read before the run below moves presentFrame away).
      if (trigger === "onHover") {
        const s = engine.snapshot();
        const nav = hit.list.find((ix) => ix.action === "navigate" && ix.destination);
        hoverReturn.current = nav && s.presentFrame ? { nodeId: hit.nodeId, fromFrame: s.presentFrame, destId: nav.destination } : null;
      }
      for (const ix of hit.list) runInteraction(ix, hit.nodeId);
      return true;
    },
    [runInteraction],
  );

  useEffect(() => {
    if (onRunInteraction) onRunInteraction(runInteraction);
  }, [onRunInteraction, runInteraction]);

  // The chip's Escape lives in the hotkey layer's cascade (ui/connSelection.ts
  // explains why the canvas listener cannot answer it itself); it is registered
  // for exactly as long as a connection is selected.
  useEffect(() => {
    registerConnDismiss(selectedConn ? () => setSelectedConn(null) : null);
    return () => registerConnDismiss(null);
  }, [selectedConn]);

  // §23 PT-016: a layer copy/cut invalidates a copied connection, so the most
  // recent copy always wins the next ⌘V.
  useEffect(() => {
    const clear = () => {
      connClipboard.current = [];
    };
    window.addEventListener("x-native-layer-copy", clear);
    return () => window.removeEventListener("x-native-layer-copy", clear);
  }, []);

  useEffect(() => {
    const updateVectorBoxSpace = (pressed: boolean) => {
      const d = drag.current;
      if (d?.mode !== "vecResize" || !d.id || !d.bounds || !d.origNetwork || !d.networkIndices) return;
      const current = engine.snapshot();
      const root = current.pages[current.page].root;
      if (pressed) {
        if (d.spaceState) return;
        const box = pointBox(root, d.id, current.vecPoints ?? []);
        if (!box) return;
        const pointer = toWorld(pointerClient.current.x, pointerClient.current.y);
        d.spaceState = { network: box.network, bounds: box.bounds, dx: 0, dy: 0, lastX: pointer.x, lastY: pointer.y };
        return;
      }
      const state = d.spaceState;
      if (!state) return;
      d.origNetwork = translatePointNetwork(root, d.id, state.network, d.networkIndices, state.dx, state.dy);
      d.bounds = { ...state.bounds, x: state.bounds.x + state.dx, y: state.bounds.y + state.dy };
      const pointer = toWorld(pointerClient.current.x, pointerClient.current.y);
      d.wx = pointer.x;
      d.wy = pointer.y;
      d.sx = pointerClient.current.x;
      d.sy = pointerClient.current.y;
      d.startAngle = Math.atan2(pointer.y - (d.bounds.y + d.bounds.h / 2), pointer.x - (d.bounds.x + d.bounds.w / 2));
      d.spaceState = undefined;
      d.rotationDeg = undefined;
    };
    const onKey = (e: KeyboardEvent) => {
      // PM-U9: while a modal is open the canvas does not answer the keyboard —
      // not the point editor's digits, not its Delete. Escape is the modal's and
      // is consumed by bindHotkeys before this runs; see ui/escape.ts.
      if (modalOpen() && e.key !== "Escape") return;
      if (
        e.type === "keydown" && eyedropArmed() && e.shiftKey && (e.metaKey || e.ctrlKey) &&
        (e.key === "Enter" || e.code === "Enter")
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (cursorPosRef.current) completeEyedrop(cursorPosRef.current.x, cursorPosRef.current.y, { shiftKey: true, create: true });
        return;
      }
      const targetEl = e.target as HTMLElement;
      const isTyping =
        targetEl?.tagName === "INPUT" ||
        targetEl?.tagName === "TEXTAREA" ||
        targetEl?.tagName === "SELECT" ||
        targetEl?.isContentEditable ||
        !!targetEl?.closest?.("input, textarea, select, [contenteditable='true'], .x-field, .x-popover, .inspector");
      // A field that takes Space as text keeps the key; every other focused
      // control hands it to the canvas, so the pan below can rotate away.
      const spaceIsText = keepsSpaceKey(targetEl);
      if (isTyping && e.key !== "Escape" && !(e.code === "Space" && !spaceIsText)) return;

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
        // Space is normally the pan modifier. During a point-box transform it
        // temporarily translates the selected points, then resumes resize or
        // rotation from the new position when released (Figma).
        const pressed = e.type === "keydown";
        if (pressed && targetEl && targetEl !== document.body && !spaceIsText) targetEl.blur();
        if (pressed !== space.current) updateVectorBoxSpace(pressed);
        space.current = pressed;
        setSpaceHeld(pressed);
        if (pressed) e.preventDefault();
      }
      if (e.type === "keydown" && (e.key === "Escape" || e.key === "Enter") && (draft.length >= 2 || penBranch.current)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (draft.length >= 2) commitPathWasm(draft, false);
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
      // ⌘↵/Ctrl↵ commits vector editing, as the dock's Done button advertises
      // ("Esc or ⌘↵"). A pending pen draft still commits first, so the chord
      // never eats points; the generic Enter branch below must not see it.
      if (
        e.type === "keydown" &&
        e.key === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
        vecEdit &&
        !edit &&
        !draft.length &&
        !penBranch.current
      ) {
        setVecEdit(null);
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      // Only a *stray pen point* is this branch's business. Without the
      // draft-length guard it swallowed every Escape on canvas (a no-op clear,
      // then `return`), so the rotation-origin, vector-edit and selected-
      // connection handlers below never ran — Escape looked dead on a
      // connection chip even though the code to dismiss it was right there.
      if (e.type === "keydown" && e.key === "Escape" && draft.length > 0 && draft.length < 2) {
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
        // §26 KB-018: Tab on a focused layer row walks the rows natively —
        // it must not also cycle the canvas selection's siblings.
        if ((e.target as HTMLElement).closest?.("[data-row-id]")) return;
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
      if (e.type === "keydown" && e.key === "Enter" && !edit && !cropId) {
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
          // Multi-edit text (360039956434): "Select the text layers you want to
          // update … Edit the contents. Any changes you make will apply to all
          // text layers you have selected." Layers with different content open
          // empty; identical content is shown for editing.
          const texts = snap.selection
            .map((sid) => worldPos(root, sid)?.node)
            .filter((x): x is XNode => !!x && x.kind === "text");
          const shared = texts.length > 1 && texts.every((x) => x.text === texts[0].text) ? texts[0].text : texts.length > 1 ? "" : n.text;
          const also = texts.length > 1 ? texts.slice(1).map((x) => x.id) : undefined;
          setEdit({ id: n.id, text: shared, also });
        }
        else if (
          n &&
          (n.kind === "frame" ||
            n.kind === "group" ||
            n.kind === "component" ||
            n.kind === "instance" ||
            (n.kind === "boolean" && n.children.length > 0)) &&
          n.children.length &&
          !vecEdit
        ) {
          // Enter drills into the container (360039959014 §Parent and child
          // interactions: "Select a child object by using Enter / Return").
          // Frames, groups, components, instances and booleans-with-children
          // all count — components/instances were missing, so Enter on a
          // component did nothing instead of selecting its first child.
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
          if (isInstanceMember(snap.pages[snap.page].root, n.id)) {
            toast("Edit the main component to change this layer");
            e.stopImmediatePropagation();
            return;
          }
          if (n.kind === "boolean") {
            // Childless booleans still bake down; basic shapes edit in
            // place — entering and leaving without touching a point leaves
            // the node untouched, and the first real edit converts kind.
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
      // Figma's Q shortcut activates the vector Lasso while a path is in point
      // edit; outside vector edit the app's radial-menu shortcut owns Q.
      if (
        e.type === "keydown" &&
        vecEdit &&
        !edit &&
        !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        e.key.toLowerCase() === "q"
      ) {
        const next = vecSubTool === "lasso" ? "select" : "lasso";
        setVecSubTool(next);
        setLassoPath([]);
        if (next === "lasso") engine.dispatch({ type: "setTool", tool: "select" });
        toast(next === "lasso" ? "Lasso: drag around points or paths" : "Select mode");
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Run 22 (vector cut, audit P1 #10): bare X toggles the Cut subtool
      // while a path is in point edit — ⇧X stays the fill/stroke swap and
      // ⌘X the clipboard cut, so both modifiers are excluded here.
      if (
        e.type === "keydown" &&
        vecEdit &&
        !edit &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "x"
      ) {
        const next = vecSubTool === "cut" ? "select" : "cut";
        setVecSubTool(next);
        toast(next === "cut" ? "Cut tool: click a point or segment, or drag across the path" : "Select mode");
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === "keydown" && e.key === "Escape" && vecEdit) {
        // First Escape cancels an in-flight Lasso or exits a vector sub-tool;
        // only the next one leaves point edit itself.
        if (drag.current?.mode === "vecLasso") {
          drag.current = null;
          setLassoPath([]);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (vecSubTool === "cut" || vecSubTool === "lasso") {
          setVecSubTool("select");
          setLassoPath([]);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        setVecEdit(null);
        e.stopImmediatePropagation();
      }
      // §23 PT-016: connections copy/paste like Figma — ⌘C on the noodle,
      // ⌘V onto a selected layer. Plain ⌘C/⌘V only, so shifted/alted layer
      // and property clipboards keep working.
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !edit && !isTyping) {
        if (e.key.toLowerCase() === "c" && selectedConn) {
          const src = worldPos(snap.pages[snap.page].root, selectedConn.srcId)?.node;
          const rows = (src?.interactions ?? []).filter((ix) => ix.destination === selectedConn.destId);
          if (rows.length) {
            connClipboard.current = rows.map((r) => ({ ...r }));
            toast("Connection copied");
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
        if (e.key.toLowerCase() === "v" && connClipboard.current.length && snap.selection[0]) {
          const target = worldPos(snap.pages[snap.page].root, snap.selection[0])?.node;
          if (target) {
            const prev = target.interactions ?? [];
            const fresh = connClipboard.current.filter(
              (c) => !prev.some((p) => p.trigger === c.trigger && p.action === c.action && p.destination === c.destination),
            );
            if (fresh.length) {
              engine.dispatch({ type: "setInteractions", id: target.id, interactions: [...prev, ...fresh.map((r) => ({ ...r }))] });
              toast("Interaction pasted");
            } else {
              toast("Already has that interaction");
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
      }
      // §23 PT-014: Escape drops the selected connection (it survived Esc).
      if (e.type === "keydown" && e.key === "Escape" && selectedConn) {
        setSelectedConn(null);
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === "keydown" && (e.key === "Delete" || e.key === "Backspace") && selectedConn && !edit) {
        engine.dispatch({ type: "deleteInteraction", id: selectedConn.srcId, destId: selectedConn.destId });
        setSelectedConn(null);
        toast("Connection deleted");
        e.stopImmediatePropagation();
        return;
      }
      // Run 23 — Delete/Backspace removes the selected width points of the
      // stroke in one undo step (a group below two points clears the profile).
      if (
        e.type === "keydown" &&
        (e.key === "Delete" || e.key === "Backspace") &&
        widthSel.length &&
        !edit &&
        !vecEdit &&
        snap.tool === "select" &&
        snap.selection.length === 1
      ) {
        const wn = worldPos(snap.pages[snap.page].root, snap.selection[0]);
        if (wn && widthEditOk(wn.node) && allowTopologyEdit(engine, wn.node.id)) {
          const prof = normalizeWidthProfile(wn.node.strokeWidthProfile);
          const next = prof.filter((_, i) => !widthSel.includes(i));
          engine.dispatch({ type: "begin" });
          engine.dispatch({ type: "patch", id: wn.node.id, patch: { strokeWidthProfile: next.length >= 2 ? next : undefined } });
          engine.dispatch({ type: "end" });
          setWidthSel([]);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
      if (e.type === "keydown" && (e.key === "Delete" || e.key === "Backspace") && vecEdit && !edit) {
        const n = worldPos(snap.pages[snap.page].root, vecEdit)?.node;
        const base = n ? (n.path.length ? n.path : shapePoly(n)) : [];
        if (n && base.length) {
          // No point selected deletes nothing (Figma): the old fallback ate
          // the last anchor on every stray Backspace.
          const selList =
            snap.vecPoints && snap.vecPoints.length > 0
              ? snap.vecPoints
              : vecPt.current >= 0
                ? [vecPt.current]
                : [];
          if (!selList.length) {
            e.stopImmediatePropagation();
            return;
          }
          if (!allowTopologyEdit(engine, n.id)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
          const selectedSet = new Set<number>(selList);
          const isHeal = e.shiftKey;
          const closed = effClosed(n);
          let path = [...base];
          if (isHeal && path.length >= 3 && selectedSet.size === 1) {
            const i = Array.from(selectedSet)[0];
            const prevIdx = i > 0 ? i - 1 : (closed ? path.length - 1 : null);
            const nextIdx = i < path.length - 1 ? i + 1 : (closed ? 0 : null);
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
          engine.dispatch({ type: "patchPath", id: n.id, path, closed });
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
    // A Space keyup that lands in another window — or in none at all, after a
    // tab switch — would otherwise leave the canvas stuck in pan mode.
    const releaseSpace = () => {
      if (space.current) updateVectorBoxSpace(false);
      space.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener("blur", releaseSpace);
    document.addEventListener("visibilitychange", releaseSpace);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", releaseSpace);
      document.removeEventListener("visibilitychange", releaseSpace);
    };
  }, [snap, edit, draft, engine, vecEdit, vecSubTool, runInteraction, selectedConn, cropId, widthSel]);

  // Radial menu ▸ Bend Tool (PM-U10). The radial is a separate component, so it
  // asks for the sub-tool over the window event bus — and until now *nothing
  // listened*: the slice reset the tool to Select and did nothing else, a menu
  // item that promised a tool and delivered a no-op while the real Bend button
  // sat in the vector-edit toolbar. The sub-tool only means anything while that
  // toolbar is up (a vector in point edit, the pen, or a path in progress), so
  // where it is not, the slice says what it needs instead of pretending.
  useEffect(() => {
    const onBend = () => {
      const ready = bendReadiness({ vecEdit, tool: engine.snapshot().tool, drafting: draft.length > 0 });
      if (!ready.ok) {
        toast(ready.need);
        return;
      }
      // The sub-tool only — deliberately not the tool: with the pen active,
      // switching to select would take the very toolbar that hosts Bend off the
      // screen, which is how "the menu item did nothing" would have become "the
      // menu item closed the tools".
      setVecSubTool("bend");
      toast(ready.say);
    };
    window.addEventListener("x-native-bend-tool", onBend);
    return () => window.removeEventListener("x-native-bend-tool", onBend);
  }, [engine, vecEdit, draft.length]);

  // Escape finishes the path and leaves it open. The finisher is published
  // to ui/penDraft.ts because that is the layer which actually decides Escape.
  useEffect(() => {
    if (!draft.length) {
      registerPenFinisher(null);
      return undefined;
    }
    registerPenFinisher(() => {
      if (draft.length >= 2) commitPathWasm(draft, false);
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
        commitPathWasm(draft, false);
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

  // Canvas2D can measure a fallback under the requested ctx.font before a
  // bundled web font arrives. Load each family/weight once; when it resolves,
  // discard the fallback widths, re-hug text that follows its content, and
  // repaint without moving the layer's x/y or touching fixed-size boxes.
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts?.load) return;
    const walk = (n: XNode) => {
      if (n.kind === "text" && n.text && n.visible) {
        for (const face of [{ fontFamily: n.fontFamily, fontWeight: n.fontWeight, fontSize: n.fontSize }, ...resolvedTextSpans(n)]) {
          const key = `${face.fontFamily}\u0000${face.fontWeight}`;
          if (!requestedFonts.current.has(key)) {
            requestedFonts.current.add(key);
            const family = face.fontFamily.replaceAll('"', "");
          void fonts.load(`${face.fontWeight} ${Math.max(1, face.fontSize)}px "${family}"`, n.text).then((faces) => {
            if (!faces.length || !canvasMounted.current) return;
            invalidateTextMeasureCache();
            setFontRevision((v) => v + 1);
            const root = engine.snapshot().pages[engine.snapshot().page].root;
            const refit = (m: XNode) => {
              if (m.kind === "text" && (m.sizingW === "hug" || m.sizingH === "hug") && [{ fontFamily: m.fontFamily, fontWeight: m.fontWeight }, ...resolvedTextSpans(m)].some((f) => `${f.fontFamily}\u0000${f.fontWeight}` === key)) {
                const dims = hugSize(m, m.text);
                if ((dims.w !== undefined && dims.w !== m.w) || (dims.h !== undefined && dims.h !== m.h))
                  engine.dispatch({ type: "patch", id: m.id, patch: dims });
              }
              for (const child of m.children) refit(child);
            };
            refit(root);
            }).catch(() => { /* unavailable font: keep the fallback visible */ });
          }
        }
      }
      for (const child of n.children) walk(child);
    };
    walk(snap.pages[snap.page].root);
  }, [snap, engine]);

  useEffect(() => {
    const c = ref.current;
    const box = wrap.current;
    if (!c || !box) return;
    const profile = snap.colorProfile ?? "srgb";
    setRenderColorProfile(profile);
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth;
    const h = box.clientHeight;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    const mainCtx = getCanvas2dContext(c);
    if (!mainCtx) return;
    // Swap slot for the offscreen passes below: a mask run, an effects
    // composite and a source tile all re-enter paint() with ctx pointed at
    // their own canvas.
    let ctx: CanvasRenderingContext2D = mainCtx;
    // Depth guard for the effects composite: the core of an effected layer is
    // painted by re-entering this same paint with its effect rows stripped, and
    // that pass must not start a second composite of its own.
    let fxDepth = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    // One style resolution per frame buys every canvas chrome role (FR-U2).
    // Fallbacks live in canvasChrome.ts and are contract-tested against the
    // light column of styles.css.
    const chrome = readCanvasChrome((token) => css.getPropertyValue(token));
    const canvasBg = chrome.canvas;
    const grid = chrome.grid;
    const themeLabel = chrome.label;
    const SEL = chrome.sel;
    const SEL_WASH = chrome.selWash;
    const SEL_GLOW = chrome.selGlow;
    const INK = chrome.ink;
    const COMP = chrome.comp;
    const LOCK = chrome.lock;
    const GUIDE = chrome.guide;
    const TARGET = chrome.target;
    const MASK = chrome.mask;
    const CHIP = chrome.chip;
    const CHIP_LINE = chrome.chipLine;
    const CHIP_INK = chrome.chipInk;
    const SCRIM = chrome.scrim;
    // Selection handles in Figma are always white squares with an accent
    // outline — they live on the document, not on panels, so they stay
    // white across themes. Reading one constant keeps the drift count at
    // one literal instead of one per painted handle.
    const HANDLE_FILL = "#ffffff";
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
    // The pixel grid is a *view* overlay, not a layer, and Figma gives it a
    // visibility floor: "only visible at zoom levels of 400% or higher", because
    // below that it is grey noise rather than something you can align to. The
    // call below is what makes it an overlay rather than a texture.
    const paintPixelGrid = () => {
      if (!page.pixelGrid || snap.zoom < 4) return;
      ctx.save();
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
      ctx.restore();
    };
    const root = page.root;
    const z = snap.zoom;
    // `maskTile` marks the pass that paints a mask into its own offscreen tile,
    // where only the mask's alpha matters: the green mask outline belongs on the
    // canvas, not in the mask (it would widen the clip by its stroke width).
    /** `tilePass`: this paint runs inside a composite tile whose transform
     * already carries the node's rotation/flip (the tile captured the live CTM
     * after `paint` applied it, see `effectsTile`). Re-applying it here would
     * rotate the subtree twice — children at double the angle and, for a
     * clipped frame, a clip square that maps back onto its own axis-aligned
     * box so content leaks past the frame. The pass paints fills/clip/children
     * exactly like the direct path and leaves the transform to the tile. */
    const paint = (n: XNode, px: number, py: number, maskTile = false, tilePass = false) => {
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
      if (!tilePass && (n.rotation || n.flipH || n.flipV)) {
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
      // The effect list this paint reads: the stored stack plus the type-menu
      // hover preview when it targets this layer. Render-only - painters that
      // take the node get a wrapper, so the document is never touched.
      const previewFx = snap.previewEffect;
      const fxList =
        previewFx && previewFx.id === n.id
          ? withPreviewEffect(n.effects ?? [], { ...previewFx, effect: defaultEffect(previewFx.kind) }, n.id)
          : (n.effects ?? []);
      const fxNode = { ...n, effects: [...fxList] };
      const sx = snap.panX + x * z;
      const sy = snap.panY + y * z;
      const sw = n.w * z;
      const sh = n.h * z;
      const round = () => roundRectPath(ctx, n, sx, sy, sw, sh, z);
      if (n.kind === "boolean" && n.booleanOp && n.children.length) {
        // Every visible drop gets its own pass over the union; the stroke
        // paints shadowless afterwards, like a text stroke.
        const dropBs = fxList.filter((e) => e.kind === "drop-shadow" && e.visible);
        for (const dropB of dropBs.length ? dropBs : [undefined]) {
          if (dropB) {
            ctx.shadowColor = cssRgba(dropB.color);
            ctx.shadowBlur = Math.max(0, dropB.blur) * z;
            ctx.shadowOffsetX = dropB.x * z;
            ctx.shadowOffsetY = dropB.y * z;
          } else {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
          }
          paintBoolean(ctx, fxNode, x, y, snap);
        }
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        if (n.strokeVisible && n.strokeWidth > 0 && (n.strokeType === "pattern" || !isNone(n.strokePaint))) {
          ctx.save();
          ctx.strokeStyle = n.strokeType === "pattern"
            ? patternStrokeStyle(ctx, n, sx, sy, z, imgOf) ?? "rgba(0,0,0,0)"
            : cssRgba(n.strokePaint);
          ctx.globalAlpha *= n.strokeOpacity ?? 1;
          ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
          ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
          ctx.miterLimit = strokeCanvasMiterLimit(n.strokeMiterAngle);
          ctx.setLineDash(n.strokeDash > 0 ? [n.strokeDash * z, (n.strokeGap || n.strokeDash) * z] : []);
          const traceBooleanStroke = (append = false) => tracePath(
            ctx, n.path.length ? n.path : shapePoly(n), snap.panX + x * z, snap.panY + y * z, z, true, append,
          );
          if (paintedStrokeAlign(n, n.strokeAlign) === "inside") {
            traceBooleanStroke();
            ctx.clip();
            traceBooleanStroke();
            ctx.lineWidth *= 2;
          } else if (paintedStrokeAlign(n, n.strokeAlign) === "outside") {
            ctx.beginPath();
            ctx.rect(-1e6, -1e6, 2e6, 2e6);
            traceBooleanStroke(true);
            ctx.clip("evenodd");
            traceBooleanStroke();
            ctx.lineWidth *= 2;
          } else traceBooleanStroke();
          ctx.stroke();
          ctx.restore();
        }
        paintExtraStrokes(
          ctx,
          n,
          z,
          (append) => tracePath(ctx, n.path.length ? n.path : shapePoly(n), snap.panX + x * z, snap.panY + y * z, z, true, append),
          { x: sx, y: sy, w: sw, h: sh },
        );
        ctx.restore();
        return;
      }
      // The module-level tracer, named so the extra-stroke layers can re-trace
      // the same outline (a stroke pass changes lineWidth and may clip, so the
      // path has to be rebuilt) and so the mask-outline overlay traces what the
      // layer actually paints instead of a second, drifting copy of this shape.
      const traceShape = (append = false) => traceNodeShape(ctx, n, sx, sy, sw, sh, z, append);
      /** Noise and texture sit on top of everything the layer paints - strokes,
       *  glyphs and children included - in row order, which is also where the
       *  effect list puts them relative to a layer blur. The clip keeps them
       *  inside the outline; open paths clip to the stroke's band instead of
       *  their zero-area trace. */
      const paintTopFx = (list: Effect[]) => {
        if (!list.length) return;
        ctx.save();
        ctx.beginPath();
        if (n.kind === "line" || n.kind === "arrow") {
          const pad = Math.max(1, ((n.strokeWidth || 1) * z) / 2);
          ctx.rect(sx - pad, sy - pad, sw + pad * 2, sh + pad * 2);
        } else {
          traceShape();
        }
        ctx.clip();
        for (const e of list) {
          if (e.kind === "noise") {
            ctx.save();
            const op = canvasBlend(e.blend);
            if (op !== "source-over") ctx.globalCompositeOperation = op;
            paintNoise(ctx, sx, sy, sw, sh, e.blur, e.spread, e.color);
            ctx.restore();
          } else {
            paintTexture(ctx, sx, sy, sw, sh, e.blur || 16, e.spread || 4);
          }
        }
        ctx.restore();
      };
      traceShape();
      if (snap.outlineMode) {
        ctx.save();
        ctx.strokeStyle = SEL;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        traceShape();
        ctx.stroke();
        ctx.restore();
        if (n.kind === "text" && edit?.id !== n.id) {
          paintText(ctx, fxNode, sx, sy, sw, sh, z, onPathGeometry(snap.pages[snap.page].root, fxNode));
        }
        if (n.kind === "frame" && n.overflow !== "visible") {
          round();
          ctx.clip();
        }
        for (const ch of n.children) paint(ch, x, y);
        ctx.restore();
        return;
      }
      const paintBackdropBlur = () => {
        const bgBlur = fxList.find((e) => (e.kind === "background-blur" || e.kind === "glass") && e.visible);
        if (!bgBlur || sw <= 1 || sh <= 1) return;
        try {
          ctx.save();
          ctx.clip();
          ctx.filter = `blur(${Math.max(0, bgBlur.blur) * z}px)`;
          // The backdrop blur samples the layers behind the selection, so the
          // source rect is grown by the kernel's reach: reading only the
          // selection's own box made the backdrop fade out at its edge
          // instead of pulling in what sits just outside it.
          const grow = Math.ceil(Math.max(0, bgBlur.blur) * z * 3);
          ctx.drawImage(c, sx - grow, sy - grow, sw + grow * 2, sh + grow * 2, sx - grow, sy - grow, sw + grow * 2, sh + grow * 2);
          ctx.restore();
        } catch {
          /* tainted canvas */
        }
      };
      // ── The effect stack ──────────────────────────────────────────────────
      // Figma renders a selection's effects as one pipeline (FIGMA_CREATE_
      // DESIGNS_COMPARISON.md §6): background blur at the bottom, then the drop
      // shadow, the fills, the inner shadow and the strokes, and on top
      // "Layer blur, noise, texture (applied in their specified order)".
      // Two of those steps cannot be expressed by painting the layer's ops
      // straight onto the canvas with ctx.filter set:
      //   · the layer blur is applied ONCE to the layer's whole composite. Set
      //     per draw op it blurs every op against the transparent gap under it
      //     (two abutting children show the background through their seam) and
      //     an op carrying its own filter (a shadow with its own blur) replaces
      //     it for that op's length;
      //   · a drop shadow is the layer's *rendered alpha*, offset, blurred and
      //     masked per pixel. A path trace cannot give that for an image fill's
      //     transparency, for glyphs, for a Boolean result or for a group's
      //     union of children - and the CTM is baked into a path as its points
      //     are added, so a translate() after the trace cannot move it either.
      // So an effected layer is rasterised once - shadow included - and the
      // blur is applied to that raster, which also lets it reach outside the
      // layer's own box the way "layer blurs … extend past a selection's
      // boundary" requires. Layers without those two effects keep the direct
      // paint path below, op for op.
      const drops = fxList.filter((e) => e.kind === "drop-shadow" && e.visible && parseHex(e.color).a > 0);
      const topGroup = fxList.filter(
        (e) => e.visible && (e.kind === "layer-blur" || e.kind === "noise" || e.kind === "texture"),
      );
      const blurAt = topGroup.findIndex((e) => e.kind === "layer-blur");
      const layerBlur = blurAt < 0 ? undefined : topGroup[blurAt];
      // Rows listed after the layer blur paint on top of the blurred composite;
      // a noise row listed before it is blurred with everything under it.
      const postBlur = blurAt < 0 ? topGroup : topGroup.slice(blurAt + 1);
      const blurPx = layerBlur ? Math.max(0, layerBlur.blur) * z : 0;
      const fxReach = drops.reduce(
        (m2, e) =>
          Math.max(
            m2,
            Math.hypot(e.x, e.y) + Math.abs(e.blur) * 2 + (spreadApplies(n) ? Math.max(0, e.spread) : 0),
          ),
        0,
      );
      const core =
        fxDepth === 0 && sw > 0 && sh > 0 && (drops.length > 0 || !!layerBlur)
          ? effectsTile(ctx, sx, sy, sw, sh, fxReach + blurPx * 3 + 4)
          : null;
      if (core) {
        // Background blur reads the live canvas, so it stays outside the tile;
        // everything else is the layer's own composite.
        paintBackdropBlur();
        const plain = fxList.filter(
          (e) =>
            e.kind !== "drop-shadow" &&
            e.kind !== "layer-blur" &&
            e.kind !== "noise" &&
            e.kind !== "texture" &&
            e.kind !== "background-blur",
        );
        const outer = ctx;
        fxDepth++;
        try {
          ctx = core.ctx;
          paint({ ...n, effects: plain }, px, py, maskTile, true);
        } finally {
          ctx = outer;
          fxDepth--;
        }
        // "Show behind transparent areas" is off by default, and off means the
        // shadow is not displayed through the layer's transparent areas: its
        // footprint is the composite's own alpha, thresholded. Rasterised, that
        // works per pixel - an image's transparency, a glyph's coverage and a
        // group's union of children included - where the path-based inverse clip
        // could only approximate it. Known-opaque layers skip it: the shadow
        // under an opaque fill is covered anyway.
        const punch =
          drops.some((e) => e.showBehind !== true) &&
          (n.children.length > 0 || n.fillType === "image" || !!n.imageSrc || dropMaskNeeds(n))
            ? (() => {
                const mask = effectsTile(ctx, sx, sy, sw, sh, fxReach + blurPx * 3 + 4);
                if (!mask) return null;
                mask.ctx.setTransform(1, 0, 0, 1, 0, 0);
                mask.ctx.drawImage(core.c, 0, 0);
                try {
                  const img = mask.ctx.getImageData(0, 0, mask.w, mask.h);
                  const d = img.data;
                  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 0 ? 255 : 0;
                  mask.ctx.putImageData(img, 0, 0);
                } catch {
                  return null; // tainted canvas: keep the un-thresholded alpha
                }
                return mask;
              })()
            : null;
        /** One drop shadow: the composite's alpha, dilated by spread where Figma
         *  applies it, blurred and moved in world axes (Figma never rotates an
         *  effect with its layer), painted in the shadow's own colour and punched
         *  through with the layer's footprint when "show behind transparent
         *  areas" is off. */
        const shadowRaster = (e: Effect) => {
          const tile = effectsTile(ctx, sx, sy, sw, sh, fxReach + blurPx * 3 + 4);
          if (!tile) return null;
          const m = ctx.getTransform();
          const dev = Math.hypot(m.a, m.b) || 1;
          const t = tile.ctx;
          // Device space from here on: the tiles are device rasters, and the
          // offset is a screen-space translation.
          t.setTransform(1, 0, 0, 1, 0, 0);
          const dx = e.x * z * dev;
          const dy = e.y * z * dev;
          const spread = (spreadApplies(n) ? Math.max(0, e.spread) : 0) * dev;
          let silhouette: { c: HTMLCanvasElement } = core;
          if (spread > 0) {
            const sil = effectsTile(ctx, sx, sy, sw, sh, fxReach + blurPx * 3 + 4);
            if (sil) {
              sil.ctx.setTransform(1, 0, 0, 1, 0, 0);
              // A ring of draws unions the alpha outwards: the round-join
              // stroke the direct path used cannot follow an image's alpha.
              for (let i = 0; i < 16; i++) {
                const a = (i / 16) * Math.PI * 2;
                sil.ctx.drawImage(core.c, Math.cos(a) * spread, Math.sin(a) * spread);
              }
              sil.ctx.drawImage(core.c, 0, 0);
              silhouette = sil;
            }
          }
          t.filter = e.blur ? `blur(${Math.max(0, e.blur) * z}px)` : "none";
          t.drawImage(silhouette.c, dx, dy);
          t.filter = "none";
          const { r, g, b, a } = parseHex(e.color);
          t.globalCompositeOperation = "source-in";
          t.fillStyle = `rgba(${r},${g},${b},${a})`;
          t.fillRect(0, 0, tile.w, tile.h);
          if (e.showBehind !== true) {
            t.globalCompositeOperation = "destination-out";
            t.drawImage((punch ?? core).c, 0, 0);
          }
          return tile;
        };
        const shadows = drops.map(shadowRaster);
        ctx.save();
        ctx.globalAlpha = parentAlpha;
        if (layerBlur) {
          // The blur is a step of its own: the shadows and the layer composite
          // first, then one filter over the lot - so the shadow blurs with the
          // layer and a clipped frame's content blurs past its own box.
          const comp = effectsTile(ctx, sx, sy, sw, sh, fxReach + blurPx * 3 + 4);
          if (comp) {
            comp.ctx.setTransform(1, 0, 0, 1, 0, 0);
            for (const list of [shadows]) {
              for (let i = 0; i < list.length; i++) {
                const op = canvasBlend(drops[i].blend);
                comp.ctx.globalCompositeOperation = op;
                comp.ctx.drawImage(list[i]!.c, 0, 0);
              }
            }
            comp.ctx.globalCompositeOperation = "source-over";
            comp.ctx.drawImage(core.c, 0, 0);
            blitTile(ctx, comp, `blur(${blurPx}px)`);
          }
        } else {
          for (let i = 0; i < shadows.length; i++) {
            const op = canvasBlend(drops[i].blend);
            ctx.globalCompositeOperation = op === "source-over" ? ctx.globalCompositeOperation : op;
            blitTile(ctx, shadows[i]!);
          }
          ctx.globalCompositeOperation = canvasBlend(n.blendMode);
          blitTile(ctx, core);
        }
        ctx.restore();
        paintTopFx(postBlur);
        ctx.restore();
        return;
      }
      // No tile (too large, or inside a composite): the direct path.
      if (layerBlur) ctx.filter = `blur(${blurPx}px)`;
      paintBackdropBlur();
      const canShadow =
        n.kind !== "text" &&
        (!!n.imageSrc ||
          paintsAnyFill(n) ||
          (n.strokeVisible && n.strokeWidth > 0 && (n.strokeType === "pattern" ? !!patternSourceNode(n.strokePattern) : !isNone(n.strokePaint))));
      if (canShadow) paintDropShadowsMasked(ctx, fxNode, z, { trace: traceShape });
      if (n.fillType === "image" || (n.imageSrc && isNone(n.fill))) {
        // A hidden base image paints nothing, but the stack above it still
        // does - each fill carries its own visibility.
        const im = n.imageSrc && n.fillVisible !== false ? imgOf(n.imageSrc) : undefined;
        if (im) {
          ctx.save();
          ctx.globalAlpha *= n.fillOpacity ?? 1;
          ctx.globalCompositeOperation = canvasBlend(n.fillBlend);
          paintImageFill(ctx, n, im, sx, sy, sw, sh);
          ctx.restore();
        }
        paintStack(ctx, n, sx, sy, sw, sh, imgOf);
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
        paintFill(ctx, n, sx, sy, sw, sh, imgOf);
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
      // Noise and texture paint last (after children), over everything else.
      const glass = fxList.find((e) => e.kind === "glass" && e.visible);
      if (glass) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha *= 0.28;
        // Document ink: an effect's own default tint, not chrome (FR-U2).
        ctx.fillStyle = glass.color || "#ffffff";
        ctx.fill();
        ctx.restore();
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      paintInnerShadows(ctx, fxNode, z, traceShape, { x: sx, y: sy, w: sw, h: sh });
      if (n.strokeVisible && n.strokeWidth > 0 && (n.strokeType === "pattern" || !isNone(n.strokePaint))) {
        ctx.save();
        ctx.globalAlpha *= n.strokeOpacity ?? 1;
        const strokeStyle = n.strokeType === "pattern"
          ? patternStrokeStyle(ctx, n, sx, sy, z, imgOf) ?? "rgba(0,0,0,0)"
          : cssRgba(n.strokePaint);
        ctx.strokeStyle = strokeStyle;
        // Run 24 — the inspector's hover previews (cap/join/style) temporarily
        // win over the stored values, exactly like the align preview below.
        const pvStroke = snap.previewStroke;
        const onPv = pvStroke && pvStroke.id === n.id ? pvStroke : null;
        const capName = onPv?.cap ?? n.strokeCap;
        ctx.lineCap = capName === "round" ? "round" : capName === "square" ? "square" : "butt";
        const joinName = onPv?.join ?? n.strokeJoin;
        ctx.lineJoin = joinName === "round" ? "round" : joinName === "bevel" ? "bevel" : "miter";
        ctx.miterLimit = strokeCanvasMiterLimit(n.strokeMiterAngle);
        // Run 24 — brush and dynamic strokes are centre-only and never dashed;
        // the style-row preview swaps in the hovered preset's dash values.
        const brushStroke = n.strokeType === "brush";
        const dynStroke = n.strokeType === "dynamic";
        const dashView = onPv?.dash
          ? {
              pattern: onPv.dash.strokeDashPattern,
              dash: onPv.dash.strokeDash,
              gap: onPv.dash.strokeGap,
              cap: onPv.dash.strokeDashCap,
            }
          : { pattern: n.strokeDashPattern, dash: n.strokeDash, gap: n.strokeGap, cap: n.strokeDashCap };
        const dashes =
          brushStroke || dynStroke ? [] : dashArray(dashView.pattern, dashView.dash, dashView.gap, z);
        // Dashes carry their own cap: a dotted line is a 1px dash
        // with round caps, and only the segments take the rounding.
        // Unset means butt — a dashed line with round end caps still
        // draws square dashes until the dash cap says otherwise.
        const dashCap = dashView.cap;
        ctx.lineCap =
          dashView.pattern?.length || dashView.dash > 0
            ? dashCap === "round"
              ? "round"
              : dashCap === "square"
                ? "square"
                : "butt"
            : ctx.lineCap;
        if (dashes.length) ctx.setLineDash(dashes);
        else ctx.setLineDash([]);
        ctx.lineDashOffset = dashOffset(dashes);
        // Individual strokes: the outline is stroked once per side, each pass
        // clipped to a 45° cone from the centre, which is how CSS mitres a
        // border and keeps a rounded corner split evenly between its sides.
        // Brush and dynamic strokes are centre-only, so they skip the split.
        const sides = sideWidths(n.strokeSides, n.strokeSideW, n.strokeWidth);
        const perSide = !brushStroke && !dynStroke && sidesSupported(n.kind) && (n.strokeSides ?? "all") !== "all";
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
          // Brush and dynamic strokes are centre-only the same way. A hover
          // preview from the inspector temporarily wins over the stored
          // position — but only a preview that actually carries an align
          // (cap/join/style previews must not drag an inside stroke to centre).
          const align =
            brushStroke || dynStroke
              ? "center"
              : onPv && onPv.align
                ? onPv.align
                : paintedStrokeAlign(n, n.strokeAlign);
          if (align === "inside") {
            ctx.save();
            ctx.clip();
            ctx.lineWidth = w * 2;
            ctx.stroke();
            ctx.restore();
          } else if (align === "outside") {
            // Canvas strokes are centred. Clip their doubled band to the
            // exterior before drawing: overpainting the interior with the
            // layer fill fails for hidden/transparent fills and covers content.
            ctx.save();
            ctx.beginPath();
            ctx.rect(-1e6, -1e6, 2e6, 2e6);
            traceShape(true);
            ctx.clip("evenodd");
            traceShape();
            ctx.lineWidth = w * 2;
            ctx.stroke();
            ctx.restore();
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
              strokeCanvasMiterLimit(n.strokeMiterAngle),
            );
          }
        }
        if (varOutline && varOutline.length >= 2) {
          tracePath(ctx, varOutline, snap.panX + x * z, snap.panY + y * z, z, true);
          ctx.fillStyle = strokeStyle;
          ctx.fill();
        } else if (brushStroke) {
          // Run 24 — three bristle passes. The translate happens BEFORE the
          // trace: path points are transformed as they are built, so an
          // offset pass has to move the CTM first.
          for (const bp of brushStrokePasses(n.strokeBrushAngle)) {
            ctx.save();
            const ox = bp.dx * n.strokeWidth * z;
            const oy = bp.dy * n.strokeWidth * z;
            if (ox || oy) ctx.translate(ox, oy);
            pass(sides[0] * bp.wMul);
            ctx.restore();
          }
        } else if (dynStroke) {
          // Run 24 — a wobbled polyline: the centreline displaced along its
          // own normals by the frequency/wiggle/smooth controls.
          const src = n.path.length >= 2 ? n.path : shapePoly(n);
          if (src.length >= 2) {
            const dev = src.map((p) => ({ x: snap.panX + x * z + p.x * z, y: snap.panY + y * z + p.y * z }));
            const wob = dynamicWobble(
              dev,
              !!n.closed,
              n.strokeDynFreq ?? 4,
              (n.strokeDynWiggle ?? 6) * z,
              n.strokeDynSmooth ?? 50,
            );
            ctx.beginPath();
            wob.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            if (n.closed) ctx.closePath();
            ctx.lineWidth = Math.max(0.5, sides[0] * z);
            ctx.stroke();
          }
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
              ctx.strokeStyle = strokeStyle;
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
            ctx.fillStyle = strokeStyle;
            ctx.fill();
          }
        }
        ctx.restore();
      }
      paintExtraStrokes(ctx, n, z, traceShape, { x: sx, y: sy, w: sw, h: sh });
      if (n.kind === "text" && edit?.id !== n.id) {
        paintText(ctx, fxNode, sx, sy, sw, sh, z, onPathGeometry(snap.pages[snap.page].root, fxNode));
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
        // Layout grids live inside their frame even when the frame's own
        // overflow is visible - an offset count can push columns past the
        // edge, and the spill must not paint over the canvas.
        ctx.beginPath();
        ctx.rect(snap.panX + x * z, snap.panY + y * z, n.w * z, n.h * z);
        ctx.clip();
        for (const g of n.layoutGrids) {
          if (g.visible === false) continue;
          const color = g.color || "rgba(255, 0, 0, 0.1)";
          ctx.fillStyle = color;
          if (g.pattern === "columns") {
            const count = g.count || 12;
            const gutter = g.gutter !== undefined ? g.gutter : 20;
            const margin = g.margin !== undefined ? g.margin : 20;
            const offset = g.offset !== undefined ? g.offset : 0;
            const x0 = x + margin + offset;
            const avail = n.w - margin * 2 - offset - gutter * (count - 1);
            const colW = g.cell !== undefined ? g.cell : Math.max(1, avail / count);
            // Fixed-width columns narrower than the frame honour alignment;
            // stretch columns fill margin to margin, so there is no slack.
            const total = colW * count + gutter * (count - 1);
            const slack = Math.max(0, n.w - margin * 2 - offset - total);
            const start = x0 + (g.alignment === "center" ? slack / 2 : g.alignment === "max" ? slack : 0);
            for (let ci = 0; ci < count; ci++) {
              const cx = start + ci * (colW + gutter);
              ctx.fillRect(snap.panX + cx * z, snap.panY + y * z, colW * z, n.h * z);
            }
          } else if (g.pattern === "rows") {
            const count = g.count || 8;
            const gutter = g.gutter !== undefined ? g.gutter : 20;
            const margin = g.margin !== undefined ? g.margin : 20;
            const offset = g.offset !== undefined ? g.offset : 0;
            const y0 = y + margin + offset;
            const avail = n.h - margin * 2 - offset - gutter * (count - 1);
            const rowH = g.cell !== undefined ? g.cell : Math.max(1, avail / count);
            const total = rowH * count + gutter * (count - 1);
            const slack = Math.max(0, n.h - margin * 2 - offset - total);
            const start = y0 + (g.alignment === "center" ? slack / 2 : g.alignment === "max" ? slack : 0);
            for (let ri = 0; ri < count; ri++) {
              const cy = start + ri * (rowH + gutter);
              ctx.fillRect(snap.panX + x * z, snap.panY + cy * z, n.w * z, rowH * z);
            }
          } else if (g.pattern === "grid") {
            const sz = g.sectionSize || 10;
            const offset = g.offset !== undefined ? g.offset : 0;
            const origin = ((offset % sz) + sz) % sz;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            // Zero offset keeps the old rhythm (first line at one cell in);
            // a nonzero offset shifts the whole lattice over by it.
            for (let gx = origin === 0 ? sz : origin; gx < n.w; gx += sz) {
              ctx.moveTo(snap.panX + (x + gx) * z, snap.panY + y * z);
              ctx.lineTo(snap.panX + (x + gx) * z, snap.panY + (y + n.h) * z);
            }
            for (let gy = origin === 0 ? sz : origin; gy < n.h; gy += sz) {
              ctx.moveTo(snap.panX + x * z, snap.panY + (y + gy) * z);
              ctx.lineTo(snap.panX + (x + n.w) * z, snap.panY + (y + gy) * z);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      // Masked runs: a mask clips every sibling after it until the next mask.
      // Each run composites offscreen - the mask is painted for real (fills,
      // strokes, glyphs, blurs, image alpha all count), its tile is reduced
      // per the mask type, and every masked sibling is painted into its own
      // tile, punched by the mask, and blitted back under the live transform.
      const paintMaskedRun = (mask: XNode, kids: XNode[]): boolean => {
        if (!kids.length) return true;
        // Screen-space union of the run, padded for spill (shadows, blurs)
        // and rotation slack, mirroring the cull bounds above.
        const spill = (c: XNode) => {
          let pad = (c.strokeWidth ?? 0) + 2;
          for (const st of c.strokes ?? []) if (st.visible) pad = Math.max(pad, st.width + 2);
          for (const e of c.effects ?? []) {
            if (!e.visible) continue;
            pad = Math.max(
              pad,
              Math.abs(e.x ?? 0) + Math.abs(e.y ?? 0) + Math.abs(e.blur ?? 0) * 2 + Math.abs(e.spread ?? 0),
            );
          }
          if (c.rotation) pad += Math.hypot(c.w, c.h) / 2 - Math.min(c.w, c.h) / 2;
          return pad * z + 4;
        };
        let ox = Infinity;
        let oy = Infinity;
        let ex = -Infinity;
        let ey = -Infinity;
        for (const c of [mask, ...kids]) {
          const q = spill(c);
          const bx = snap.panX + (x + c.x) * z - q;
          const by = snap.panY + (y + c.y) * z - q;
          ox = Math.min(ox, bx);
          oy = Math.min(oy, by);
          ex = Math.max(ex, bx + c.w * z + q * 2);
          ey = Math.max(ey, by + c.h * z + q * 2);
        }
        ox = Math.floor(ox);
        oy = Math.floor(oy);
        const ow = Math.ceil(ex - ox);
        const oh = Math.ceil(ey - oy);
        if (!(ow > 0 && oh > 0)) return true;
        // Tile pixels per user unit, straight from the live transform (which
        // carries the dpr scale and every ancestor rotation above this node).
        const m = ctx.getTransform();
        const sx = Math.hypot(m.a, m.b) || 1;
        const sy = Math.hypot(m.c, m.d) || 1;
        const tw = Math.max(1, Math.ceil(ow * sx));
        const th = Math.max(1, Math.ceil(oh * sy));
        if (tw > 8192 || th > 8192 || tw * th > 16777216) return false;
        const tile = () => {
          const c = document.createElement("canvas");
          c.width = tw;
          c.height = th;
          const t = getCanvas2dContext(c);
          if (t) t.setTransform(m.a, m.b, m.c, m.d, m.e - (ox * m.a + oy * m.c), m.f - (ox * m.b + oy * m.d));
          return t;
        };
        const prev = ctx;
        const into = (t: CanvasRenderingContext2D | null, c: XNode, maskTile = false) => {
          if (!t) return false;
          ctx = t;
          try {
            paint(c, x, y, maskTile);
          } finally {
            ctx = prev;
          }
          return true;
        };
        // The mask paints with its opacity but never its blend mode: blending
        // against a transparent tile is meaningless, and the mask's job is
        // only to supply alpha (or luminance).
        const mt = tile();
        if (!into(mt, { ...mask, blendMode: "normal" }, true)) return false;
        const mc = mt!.canvas;
        const type = mask.maskType || "alpha";
        if (type !== "alpha") {
          try {
            const img = mt!.getImageData(0, 0, tw, th);
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
              d[i + 3] = reduceMaskAlpha(type, d[i], d[i + 1], d[i + 2], d[i + 3]);
            }
            mt!.putImageData(img, 0, 0);
          } catch {
            // Tainted tile (an external image without CORS): the unprocessed
            // alpha stands in for the requested reduction.
          }
        }
        for (const k of kids) {
          const kt = tile();
          if (!into(kt, k)) return false;
          kt!.save();
          kt!.globalCompositeOperation = "destination-in";
          // The mask raster covers exactly the run box, so it goes back at the
          // box's origin and size - the same rect the punched tile is blitted
          // with below. Drawing it at (0, 0) at natural size instead put the
          // mask's alpha wherever the run's padding happened to land (6 device
          // px down-right for a 100px box), so the soft edge of a gradient mask
          // sampled the neighbouring pixel and the mask bled past its own box.
          kt!.drawImage(mc, ox, oy, ow, oh);
          kt!.restore();
          ctx.drawImage(kt!.canvas, ox, oy, ow, oh);
        }
        return true;
      };
      const paintGeometricMask = (ch: XNode) => {
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
      };
      // View > Mask outlines, dashed out of the mask tile: "Once the setting
      // on, masks in your file are outlined in green. Note: If all layers being
      // masked are hidden or have zero percent opacity, then the object's mask
      // outlines won't appear." A mask whose run has no visible, non-zero-alpha
      // kid therefore draws nothing, and the line is traced from the same shape
      // tracer the layer paints with, so it follows any kind of mask layer.
      const strokeMaskOutline = (mask: XNode, kids: XNode[]) => {
        if (maskTile || !snap.showMaskOutlines || !mask.visible) return;
        if (!kids.some((k) => k.visible && (k.opacity ?? 1) > 0)) return;
        const mx = snap.panX + (x + mask.x) * z;
        const my = snap.panY + (y + mask.y) * z;
        ctx.save();
        if (mask.rotation || mask.flipH || mask.flipV) {
          const mcx = mx + (mask.w * z) / 2;
          const mcy = my + (mask.h * z) / 2;
          ctx.translate(mcx, mcy);
          if (mask.rotation) ctx.rotate((mask.rotation * Math.PI) / 180);
          if (mask.flipH || mask.flipV) ctx.scale(mask.flipH ? -1 : 1, mask.flipV ? -1 : 1);
          ctx.translate(-mcx, -mcy);
        }
        ctx.strokeStyle = MASK;
        ctx.lineWidth = Math.max(1, z);
        ctx.setLineDash([]);
        traceNodeShape(ctx, mask, mx, my, mask.w * z, mask.h * z, z);
        ctx.stroke();
        ctx.restore();
      };
      // Sections paint first: Figma keeps a section behind the objects it
      // holds, whatever order the document lists them in.
      const renderChildren = sectionsFirst(n.layout?.itemReverseZIndex ? [...n.children].reverse() : n.children);
      for (const run of partitionMaskRuns(renderChildren)) {
        if (!run.mask) {
          for (const k of run.kids) paint(k, x, y);
        } else {
          if (!paintMaskedRun(run.mask, run.kids)) {
            paintGeometricMask(run.mask);
            for (const k of run.kids) paint(k, x, y);
            ctx.restore();
          }
          strokeMaskOutline(run.mask, run.kids);
        }
      }
      paintTopFx(fxList.filter((e) => (e.kind === "noise" || e.kind === "texture") && e.visible));
      if (!maskTile && snap.showMaskOutlines && n.isMask && n.visible) {
        ctx.save();
        ctx.strokeStyle = MASK;
        ctx.lineWidth = Math.max(1, z);
        ctx.setLineDash([]);
        ctx.beginPath();
        traceShape();
        ctx.stroke();
        ctx.restore();
      }
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
      // The page's own children take the same section-first order a container's
      // do: Figma keeps a section behind the frames that sit on it.
      for (const ch of sectionsFirst(root.children)) paint(ch, 0, 0);
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
        const tctx = getCanvas2dContext(tmp);
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

    // The document is on the canvas; the pixel grid goes over it. Everything
    // below this line is editor chrome — names, hover outline, selection rings,
    // point handles — and all of it stays above the grid, which is what makes
    // the grid usable as an alignment reference instead of a texture.
    paintPixelGrid();

    // A frame's name sits above its top-left corner at a constant 11px, so it
    // stays the same size as the canvas zooms. Selected or hovered, it takes
    // the accent colour indicating the name belongs to the frame you
    // are about to act on.
    const labelNames = (n: XNode, parentIsFrame: boolean, selectedAncestor = false) => {
      if (!n.visible) return;
      // A label is document chrome, but its anchor is still the layer's actual
      // top-left corner. Summing x/y only works until an ancestor rotates or
      // flips; use the same full matrix as the painter and selection chrome.
      const origin = localToWorld(root, n.id, 0, 0);
      const screenX = snap.panX + origin.x * z;
      const screenY = snap.panY + origin.y * z;
      const selected = snap.selection.includes(n.id);
      // Skip labels whose layer is off-screen: at any zoom a page can hold
      // hundreds of them, and fillText for each is the one thing on this
      // canvas that runs per layer rather than per visible pixel.
      const labelOnScreen =
        screenX > -400 && screenX < w + 400 && screenY > -40 && screenY < h + 400;
      if (n.kind === "section") {
        // "Double-click the section title on the canvas or Layers panel. Edit
        // the title." The title is the section's own chrome, so it draws
        // whatever the selection is, inside the box's top-left, at a constant
        // 12px while the canvas zooms.
        if (labelOnScreen) {
          ctx.save();
          ctx.font = "600 12px Inter, system-ui";
          ctx.fillStyle = canvasLabel;
          ctx.textBaseline = "alphabetic";
          ctx.fillText(n.name, screenX + 8, screenY + 16);
          ctx.restore();
        }
      } else if (
        n.kind === "frame" &&
        n.showName !== false &&
        // Nested names stay out of the content flow unless explicitly selected.
        // A selected ancestor suppresses unselected descendant names only.
        (selected || (!parentIsFrame && !selectedAncestor)) &&
        labelOnScreen
      ) {
        const active = selected || hoverId === n.id || panelHover === n.id;
        ctx.save();
        // Weight does not carry selection state here — colour does, exactly as in
        // Figma, where a selected frame's name is the same 11px medium as every
        // other label, only in the selection ink.
        ctx.font = "500 11px Inter, system-ui";
        ctx.fillStyle = active ? SEL : canvasLabel;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(n.name, screenX, screenY - 8);
        ctx.restore();
      }
      for (const c of n.children) {
        labelNames(c, n.kind === "frame", selectedAncestor || selected);
      }
    };
    if (!snap.presentFrame) {
      for (const ch of root.children) labelNames(ch, false);
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
        ctx.strokeStyle = SEL;
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
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (draft.length) {
      ctx.strokeStyle = SEL;
      ctx.lineWidth = 1.5;
      const preview = ghost ? [...draft, ghost] : draft;
      tracePath(ctx, preview, snap.panX, snap.panY, z, false);
      ctx.stroke();
      for (const p of draft) {
        const i = draft.indexOf(p);
        const px = snap.panX + p.x * z;
        const py = snap.panY + p.y * z;
        if ((p.ox && p.ox !== 0) || (p.oy && p.oy !== 0) || (p.ix && p.ix !== 0) || (p.iy && p.iy !== 0)) {
          ctx.strokeStyle = SEL;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + (p.ix || 0) * z, py + (p.iy || 0) * z);
          ctx.lineTo(px + (p.ox || 0) * z, py + (p.oy || 0) * z);
          ctx.stroke();
          for (const [hx, hy] of [
            [px + (p.ix || 0) * z, py + (p.iy || 0) * z],
            [px + (p.ox || 0) * z, py + (p.oy || 0) * z],
          ] as const) {
            ctx.fillStyle = INK;
            ctx.beginPath();
            ctx.arc(hx, hy, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.fillStyle = INK;
        ctx.strokeStyle = SEL;
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

          ctx.fillStyle = SEL;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(px, py, pw, ph, 11);
          } else {
            ctx.rect(px, py, pw, ph);
          }
          ctx.fill();

          // Play icon
          ctx.fillStyle = INK;
          ctx.beginPath();
          ctx.moveTo(px + 8, py + 6);
          ctx.lineTo(px + 16, py + 11);
          ctx.lineTo(px + 8, py + 16);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = INK;
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
          ctx.strokeStyle = INK;
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.moveTo(sax, say);
          ctx.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sbx, sby);
          ctx.stroke();
        }

        ctx.strokeStyle = isOverlay ? COMP : SEL;
        ctx.lineWidth = isSelected ? 2.5 : 1.8;
        if (isOverlay) ctx.setLineDash([5, 4]);

        ctx.beginPath();
        ctx.moveTo(sax, say);
        ctx.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sbx, sby);
        ctx.stroke();

        // Source circular anchor dot
        ctx.fillStyle = isOverlay ? COMP : SEL;
        ctx.beginPath();
        ctx.arc(sax, say, isSelected ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = isSelected ? 2 : 1.25;
        ctx.stroke();

        // Destination rotated arrowhead
        ctx.save();
        ctx.translate(sbx, sby);
        ctx.rotate(noodle.angle);
        ctx.fillStyle = isOverlay ? COMP : SEL;
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
            ctx.fillStyle = SEL;
            ctx.fill();
            ctx.strokeStyle = INK;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Plus symbol inside handle
            ctx.beginPath();
            ctx.strokeStyle = INK;
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
        ctx.strokeStyle = SEL;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(sax, say);
        ctx.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sbx, sby);
        ctx.stroke();

        // Source circle
        ctx.fillStyle = SEL;
        ctx.beginPath();
        ctx.arc(sax, say, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Destination indicator / arrow
        if (twp) {
          ctx.save();
          ctx.translate(sbx, sby);
          ctx.rotate(noodle.angle);
          ctx.fillStyle = SEL;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-9, -5);
          ctx.lineTo(-7, 0);
          ctx.lineTo(-9, 5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = SEL;
          ctx.beginPath();
          ctx.arc(sbx, sby, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Highlight candidate destination frame
        if (twp) {
          ctx.strokeStyle = SEL;
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
          ctx.fillStyle = SEL;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = INK;
          ctx.stroke();

          ctx.fillStyle = INK;
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

            ctx.fillStyle = CHIP;
            ctx.strokeStyle = CHIP_LINE;
            ctx.lineWidth = 1;
            if (typeof ctx.roundRect === "function") {
              ctx.beginPath();
              ctx.roundRect(cardX, cardY, textWidth, cardH, 6);
              ctx.fill();
              ctx.stroke();
            } else {
              ctx.fillRect(cardX, cardY, textWidth, cardH);
            }

            ctx.fillStyle = SEL;
            ctx.font = "bold 9px Inter, system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText(`SPEC #${idx + 1} · ${ann.author || "Dev"}`, cardX + 8, cardY + 6);

            ctx.fillStyle = CHIP_INK;
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
        ctx.strokeStyle = SEL;
        ctx.lineWidth = 1;
        ctx.strokeRect(hx + 0.5, hy + 0.5, hw, hh);
        ctx.restore();
      }
    }

    // The article's first affordance: a hovered circle shows its arc controls
    // ("When you hover over the circle, a single handle will appear on the
    // right-hand side"), so the sweep can be grabbed without selecting first.
    // A selected ellipse paints the same set in the selection pass below.
    if (hovId && !snap.selection.includes(hovId) && snap.tool === "select" && !vecEdit) {
      const ap = worldPos(root, hovId);
      if (ap && ap.node.kind === "ellipse") {
        const ab = nodeVisualBounds(ap);
        const ax = snap.panX + ab.x * z;
        const ay = snap.panY + ab.y * z;
        const aw = ab.w * z;
        const ah = ab.h * z;
        if (aw >= 36 && ah >= 36) {
          ctx.save();
          if (ap.node.rotation || ap.node.flipH || ap.node.flipV) {
            ctx.translate(ax + aw / 2, ay + ah / 2);
            if (ap.node.rotation) ctx.rotate((ap.node.rotation * Math.PI) / 180);
            if (ap.node.flipH || ap.node.flipV) ctx.scale(ap.node.flipH ? -1 : 1, ap.node.flipV ? -1 : 1);
            ctx.translate(-(ax + aw / 2), -(ay + ah / 2));
          }
          paintArcHandles(ctx, ap.node, ax, ay, aw, ah, INK, SEL);
          ctx.restore();
        }
      }
    }

    // Frame tool: hovering a frame parks a + badge on each side edge for
    // one-click duplication; ⌥-click places a blank same-size frame instead.
    // Badges appear on all four sides (left/right/top/bottom) matching the
    // Figma help reference.
    if (snap.tool === "frame" && hoverId && !snap.selection.includes(hoverId)) {
      const qf = worldPos(root, hoverId);
      const qb = qf && qf.node.kind === "frame" && !qf.node.rotation ? nodeVisualBounds(qf) : null;
      if (qf && qb) {
        const qx = snap.panX + qb.x * z;
        const qy = snap.panY + qb.y * z;
        const qw = qb.w * z;
        const qh = qb.h * z;
        ctx.save();
        // Four badges: left, right, top, bottom edges at midpoint.
        const badges: Array<[number, number, "l" | "r" | "t" | "b"]> = [
          [qx, qy + qh / 2, "l"],
          [qx + qw, qy + qh / 2, "r"],
          [qx + qw / 2, qy, "t"],
          [qx + qw / 2, qy + qh, "b"],
        ];
        for (const [cx, cy] of badges) {
          ctx.beginPath();
          ctx.arc(cx, cy, 9, 0, Math.PI * 2);
          ctx.fillStyle = SEL;
          ctx.fill();
          ctx.strokeStyle = INK;
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
      const accent = wp.node.isComponent || wp.node.componentId ? COMP : SEL;
      const lockedSel = isEffectivelyLocked(root, wp.node.id);
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
      // A locked layer keeps its outline but loses the editable accent: the
      // grey dashed ring says "selected, not grabbable" (move/resize refuse
      // it; the resize handles below are suppressed for the same reason).
      ctx.strokeStyle = lockedSel ? LOCK : accent;
      ctx.lineWidth = 1;
      if (lockedSel) ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
      ctx.setLineDash([]);
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
      if (lockedSel) hs = [];
      // Handle style matches Figma: hollow white squares with a 1px outline
      // in the selection accent. Frames/components/instances get the full 8
      // (4 corners + 4 mid-edges); plain shapes show the 4 corners. Nothing
      // is painted for rotation — the ring at the corners of the bounds is a
      // cursor-only affordance, hit-tested below (Figma draws no handle).
      for (const [hx, hy] of hs) {
        const isCorner =
          (Math.abs(hx - sx) < 1 || Math.abs(hx - (sx + sw)) < 1) &&
          (Math.abs(hy - sy) < 1 || Math.abs(hy - (sy + sh)) < 1);
        // Skip mid-edge handles on non-container shapes so they read as four,
        // matching Figma's rectangle/ellipse/text selection chrome.
        if (!isCorner && !isFrame) continue;
        if (isVectorLike) {
          // Diamond handles for editable vector/boolean/star/polygon nodes.
          ctx.fillStyle = HANDLE_FILL;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hx, hy - 4);
          ctx.lineTo(hx + 4, hy);
          ctx.lineTo(hx, hy + 4);
          ctx.lineTo(hx - 4, hy);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          // Hollow square: 8×8 for containers, 7×7 for plain shapes, white fill
          // with the accent stroke — Figma's handle boxes, measured off its
          // selection chrome at 100%. Painted one inset (`s - 1`) so the 1px
          // stroke lands on the box edge.
          const s = isFrame ? 8 : 7;
          const half = s / 2;
          ctx.fillStyle = HANDLE_FILL;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.fillRect(hx - half + 0.5, hy - half + 0.5, s - 1, s - 1);
          ctx.strokeRect(hx - half + 0.5, hy - half + 0.5, s - 1, s - 1);
        }
      }
      // Text-on-path start handle (360039956434): a diamond where the text
      // begins along its path; dragging slides `pathStart`.
      if (wp.node.onPath && !lockedSel) {
        const pgeom = onPathGeometry(snap.pages[snap.page].root, wp.node);
        if (pgeom) {
          const p = walkAt(pgeom.walk, (wp.node.pathStart ?? 0) * pgeom.walk.len);
          const hx = sx + (pgeom.dx + p.x) * z;
          const hy = sy + (pgeom.dy + p.y) * z;
          ctx.beginPath();
          ctx.moveTo(hx, hy - 5);
          ctx.lineTo(hx + 5, hy);
          ctx.lineTo(hx, hy + 5);
          ctx.lineTo(hx - 5, hy);
          ctx.closePath();
          ctx.fillStyle = INK;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
        }
      }
      // No painted rotation handle, on purpose. Figma's rotate affordance is the
      // *cursor*, not chrome: hovering just outside a corner swaps to
      // `ROT_CURSOR` and dragging from there rotates, with the angle readout below
      // as the only in-canvas feedback. The stem + hollow dot that used to live
      // here was ours (top-centre first, then top-right per the 09-29 correction);
      // a screenshot comparison against Figma settled it in batch 45, and the
      // invisible band `rotationHandleHit` measures is all that remains.
      // Dynamic rotation angle readout badge when rotating
      const isRotating = drag.current?.mode === "rotate" && drag.current.id === wp.node.id;
      const dim = isRotating
        ? `${Math.round(find(root, wp.node.id)?.rotation ?? 0)}°`
        : lockedSel
          ? "Locked"
          : `${Math.round(nb.w)} × ${Math.round(nb.h)}`;
      ctx.font = "500 11px Inter, system-ui";
      const tw = ctx.measureText(dim).width;
      const bw = tw + 16;
      const bh = 20;
      // FR-U4: the readout used to hang 8px below the box unconditionally, so a
      // selection whose bottom edge was at the canvas bottom lost it — usually
      // mid-resize of something tall, which is when it is wanted most.
      const badge = clampBadge(
        { x: sx + sw / 2 - bw / 2, y: sy + sh + 8, w: bw, h: bh },
        { w, h },
        { flipY: sy - 8 - bh },
      );
      const bx = badge.x;
      const by = badge.y;
      ctx.fillStyle = lockedSel && !isRotating ? LOCK : accent;
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
      } else {
        ctx.fillRect(bx, by, bw, bh);
      }
      ctx.fillStyle = INK;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(dim, bx + bw / 2, by + bh / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      const gt = !lockedSel ? gradTarget(wp.node) : null;
      if (gt) {
        const ax = sx + gt.gx * sw;
        const ay = sy + gt.gy * sh;
        const bx = sx + gt.hx * sw;
        const by = sy + gt.hy * sh;
        ctx.strokeStyle = SEL;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        // Intermediate colour stops belong on the canvas, not only in the
        // inspector. The end stops are the larger geometry handles below;
        // keeping them separate gives endpoints first-class hit priority.
        for (const stop of gt.stops) {
          if (stop.position <= 0.001 || stop.position >= 0.999) continue;
          const x = ax + (bx - ax) * stop.position;
          const y = ay + (by - ay) * stop.position;
          ctx.fillStyle = stop.color;
          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.fillStyle = gt.from;
        ctx.beginPath();
        ctx.arc(ax, ay, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = gt.to;
        ctx.beginPath();
        ctx.arc(bx, by, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Interpolation midpoints: a small square between every adjacent
        // pair — where dragging splits the blend of those two stops.
        for (let i = 0; i < gt.stops.length - 1; i++) {
          const p0 = gt.stops[i].position;
          const p1 = gt.stops[i + 1].position;
          const span = p1 - p0;
          if (span <= 1e-4) continue;
          const m = Math.max(0, Math.min(1, gt.mids?.[i] ?? 0.5));
          const x = ax + (bx - ax) * (p0 + span * m);
          const y = ay + (by - ay) * (p0 + span * m);
          ctx.fillStyle = INK;
          ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
          ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
        }
        // Radial focal point: a hollow ring around the convergence of the
        // first stop. It sits outside the filled centre dot (r6) so both
        // stay grabbable even when the focal is still at the centre.
        if (gt.type === "radial") {
          ctx.beginPath();
          ctx.arc(sx + gt.fx * sw, sy + gt.fy * sh, 11, 0, Math.PI * 2);
          ctx.stroke();
        }
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
        ctx.fillStyle = INK;
        ctx.strokeStyle = SEL;
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
        ctx.fillStyle = INK;
        ctx.strokeStyle = SEL;
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
        paintArcHandles(ctx, wp.node, sx, sy, sw, sh, INK, SEL);
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
        ctx.save();
        ctx.fillStyle = "rgba(255, 45, 85, 0.14)";
        const band = (bx: number, by: number, bw: number, bh: number) => {
          if (bw > 0.5 && bh > 0.5) ctx.fillRect(bx, by, bw, bh);
        };
        band(sx, sy, sw, pt * z);
        band(sx, sy + sh - pb * z, sw, pb * z);
        band(sx, sy + pt * z, pl * z, Math.max(0, sh - (pt + pb) * z));
        band(sx + sw - pr * z, sy + pt * z, pr * z, Math.max(0, sh - (pt + pb) * z));

        // The gap bands are the SAME rectangles the hover cursor and the
        // press measure (`autoGapPills`): every adjacent pair of flowed
        // children, line-straddling pairs skipped in a wrapping flow, plus
        // one band for the space between wrapped lines. Paint = hit target.
        for (const pill of autoGapPills(wp.node)) {
          band(
            sx + pill.x0 * z,
            sy + pill.y0 * z,
            Math.max(2, (pill.x1 - pill.x0) * z),
            Math.max(2, (pill.y1 - pill.y0) * z),
          );
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
        ctx.fillStyle = INK;
        ctx.fill();
        ctx.strokeStyle = SEL;
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
        const allLocked = snap.selection.every((id) => isEffectivelyLocked(root, id));
        ctx.strokeStyle = allLocked ? LOCK : SEL;
        ctx.lineWidth = 1;
        if (allLocked) ctx.setLineDash([4, 3]);
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
        ctx.setLineDash([]);
        const hsMulti: [number, number][] = allLocked ? [] : handles(sx, sy, sw, sh);
        for (const [hx, hy] of hsMulti) {
          // Multi-selection uses the same hollow-square recipe as a single selected
          // container — white fill, selection-accent stroke, the 8px box — because
          // the bounds of several layers are a container-shaped thing, and Figma
          // draws them at one size. The grab is an 8px radius around the handle
          // centre either way, so only the pixels change, not what you can hit.
          ctx.fillStyle = HANDLE_FILL;
          ctx.strokeStyle = SEL;
          ctx.lineWidth = 1;
          ctx.fillRect(hx - 4 + 0.5, hy - 4 + 0.5, 7, 7);
          ctx.strokeRect(hx - 4 + 0.5, hy - 4 + 0.5, 7, 7);
        }
        const dim = allLocked ? "Locked" : `${Math.round(bb.w)} × ${Math.round(bb.h)}`;
        ctx.font = "500 11px Inter, system-ui";
        const bw = ctx.measureText(dim).width + 16;
        // FR-U4, the multi-selection badge: same clamp, same flip above the box.
        const badge = clampBadge(
          { x: sx + sw / 2 - bw / 2, y: sy + sh + 8, w: bw, h: 20 },
          { w, h },
          { flipY: sy - 8 - 20 },
        );
        const bx = badge.x;
        const by = badge.y;
        ctx.fillStyle = allLocked ? LOCK : SEL;
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, 20, 4);
          ctx.fill();
        } else ctx.fillRect(bx, by, bw, 20);
        ctx.fillStyle = INK;
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
      ctx.strokeStyle = GUIDE;
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
    // Gap pills, one painter: the equal-spacing feedback from a move drag and
    // the smart-selection handles that sit between the layers of a 1D run -
    // "a tooltip above your cursor shows the current space between layers, in
    // pixels" (Figma help 360040450233). Both are the guide pink, the same
    // chrome the measurement overlay uses.
    const paintGapPills = (list: GapBadge[]) => {
      ctx.save();
      ctx.font = "500 10px Inter, system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const g of list) {
        const cx = g.axis === "x" ? snap.panX + g.at * z : snap.panX + g.cross * z;
        const cy = g.axis === "x" ? snap.panY + g.cross * z : snap.panY + g.at * z;
        const label = `${Math.round(g.size)}`;
        const bw = ctx.measureText(label).width + 10;
        ctx.fillStyle = GUIDE;
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(cx - bw / 2, cy - 8, bw, 16, 3);
          ctx.fill();
        } else ctx.fillRect(cx - bw / 2, cy - 8, bw, 16);
        ctx.fillStyle = INK;
        ctx.fillText(label, cx, cy);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.restore();
    };
    if (gapBadges.length) paintGapPills(gapBadges);
    // The at-rest handles step aside while another gesture is live so the two
    // pill sets never double up; during their own drag they move with the gaps.
    if (smartGaps.length && !band && (!drag.current || drag.current.mode === "smartGap")) {
      paintGapPills(smartGaps);
    }
    // The drop target during a move drag: the frame's outline, plus the blue
    // insertion line in a flow - the same gap the drop would land in.
    if (dropHint) {
      ctx.save();
      ctx.strokeStyle = TARGET;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        snap.panX + dropHint.fx * z,
        snap.panY + dropHint.fy * z,
        Math.max(1, dropHint.fw * z),
        Math.max(1, dropHint.fh * z),
      );
      const ln = dropHint.line;
      if (ln) {
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (ln.horiz) {
          const x = snap.panX + ln.at * z;
          ctx.moveTo(x, snap.panY + ln.from * z);
          ctx.lineTo(x, snap.panY + ln.to * z);
        } else {
          const y = snap.panY + ln.at * z;
          ctx.moveTo(snap.panX + ln.from * z, y);
          ctx.lineTo(snap.panX + ln.to * z, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Boolean live preview: the armed op's result over the live selection,
    // recomputed every frame so it tracks drags and nudges until Apply/Esc.
    if (snap.booleanPreview && snap.selection.length >= 2 && !snap.presentFrame) {
      const prev = previewBoolean(snap.booleanPreview, root, snap.selection);
      if (prev && prev.path.length >= 3) {
        ctx.save();
        tracePath(ctx, prev.path, snap.panX + prev.x * z, snap.panY + prev.y * z, z, true);
        ctx.fillStyle = SEL_WASH;
        ctx.fill();
        ctx.strokeStyle = SEL;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Run 23 — variable-width control points on the selected stroke: the
    // stations, a pink preview handle where the pointer projects onto the
    // line (a ring over an existing point), and highlighted selections with
    // their width in px. Hidden under rotation, where the translation-only
    // page offset would misplace them.
    if (snap.selection.length === 1 && !snap.presentFrame && !vecEdit && snap.tool === "select") {
      const sel = find(root, snap.selection[0]);
      if (sel && widthEditOk(sel) && allowTopologyEdit(engine, sel.id)) {
        const wp = worldPos(root, sel.id);
        if (wp) {
          const prof = normalizeWidthProfile(sel.strokeWidthProfile);
          const dots = widthProfileStations(sel.path, sel.closed, prof);
          if (dots.length || widthHover || widthSel.length) {
            ctx.save();
            ctx.font = "11px sans-serif";
            for (const d of dots) {
              ctx.beginPath();
              ctx.arc(snap.panX + (wp.x + d.x) * z, snap.panY + (wp.y + d.y) * z, 3.5, 0, Math.PI * 2);
              ctx.fillStyle = INK;
              ctx.fill();
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = SEL;
              ctx.stroke();
            }
            // Selected points stand out and show the width they produce.
            for (const i of widthSel) {
              const d = dots[i];
              if (!d) continue;
              ctx.beginPath();
              ctx.arc(snap.panX + (wp.x + d.x) * z, snap.panY + (wp.y + d.y) * z, 6, 0, Math.PI * 2);
              ctx.lineWidth = 2;
              ctx.strokeStyle = SEL;
              ctx.stroke();
              ctx.fillStyle = INK;
              ctx.fillText(
                `${Math.round((sel.strokeWidth || 1) * (prof[i]?.widthMultiplier ?? 1))}px`,
                snap.panX + (wp.x + d.x) * z + 9,
                snap.panY + (wp.y + d.y) * z - 7,
              );
            }
            // The pink preview follows the pointer along the stroke.
            if (widthHover && widthHover.id === sel.id) {
              const hx = snap.panX + (wp.x + widthHover.x) * z;
              const hy = snap.panY + (wp.y + widthHover.y) * z;
              ctx.beginPath();
              ctx.arc(hx, hy, widthHover.onPoint != null ? 7 : 5, 0, Math.PI * 2);
              if (widthHover.onPoint != null) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = GUIDE;
                ctx.stroke();
              } else {
                ctx.fillStyle = GUIDE;
                ctx.fill();
                ctx.lineWidth = 1;
                ctx.strokeStyle = INK;
                ctx.stroke();
              }
            }
            ctx.restore();
          }
        }
      }
    }

    // Run 22: the vector-cut preview — a dashed blade line from the press
    // to the pointer while the cut drags.
    if (cutLine) {
      ctx.save();
      ctx.strokeStyle = SEL;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(snap.panX + cutLine.x1 * z, snap.panY + cutLine.y1 * z);
      ctx.lineTo(snap.panX + cutLine.x2 * z, snap.panY + cutLine.y2 * z);
      ctx.stroke();
      ctx.restore();
    }

    // Figma's insert preview: a + sitting exactly where the next click puts a
    // new anchor. It is painted for whichever gesture is armed — point edit over
    // a segment, or the pen over the selected path — from the one measurement the
    // click itself uses, so what you see is where it lands. Drawn in the node's
    // own rotated space, like the point overlay below it.
    if (addPt) {
      const awp = worldPos(root, addPt.id);
      if (awp) {
        const asw = awp.node.w * z;
        const ash = awp.node.h * z;
        const asx = snap.panX + awp.x * z;
        const asy = snap.panY + awp.y * z;
        ctx.save();
        if (awp.node.rotation || awp.node.flipH || awp.node.flipV) {
          ctx.translate(asx + asw / 2, asy + ash / 2);
          if (awp.node.rotation) ctx.rotate((awp.node.rotation * Math.PI) / 180);
          if (awp.node.flipH || awp.node.flipV) ctx.scale(awp.node.flipH ? -1 : 1, awp.node.flipV ? -1 : 1);
          ctx.translate(-(asx + asw / 2), -(asy + ash / 2));
        }
        const ax = asx + addPt.x * z;
        const ay = asy + addPt.y * z;
        const arm = 4.5;
        // A halo first, then the accent cross: the mark has to read on a dark
        // fill as clearly as on the page.
        ctx.lineCap = "round";
        for (const [color, width] of [
          [INK, 3.5],
          [SEL, 1.75],
        ] as const) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(ax - arm, ay);
          ctx.lineTo(ax + arm, ay);
          ctx.moveTo(ax, ay - arm);
          ctx.lineTo(ax, ay + arm);
          ctx.stroke();
        }
        ctx.restore();
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
        const vn = wp.node.vectorNetwork;
        // ── Path skeleton (Figma's "centre line") ────────────────────────────
        // The structure you are editing has to read as structure, not as the
        // artwork: every edge draws over the shape in the selection hue, the
        // edges *between two selected anchors* at full strength and 1.5px, the
        // rest as a thinner, dimmed skeleton. Without it the network is invisible
        // and segment selection has nothing to show; with both edges drawn alike
        // there is no answer to "which of these would my click grab".
        // Curved edges follow the cubic, so the skeleton is the path, not its chord.
        // One definition of "selected" for the whole overlay — the same reading the
        // anchor dots use two lines later, so an anchor never highlights without its
        // edges highlighting. `vecPoints` is the multi-set, `vecPoint` the single
        // selection, `vecPt.current` the point being dragged this frame.
        const selNow = new Set<number>(
          (snap.vecPoints && snap.vecPoints.length ? snap.vecPoints : vecPt.current >= 0 ? [vecPt.current] : []).concat(
            snap.vecPoint != null ? [snap.vecPoint] : [],
          ),
        );
        const skelCount = effClosed(wp.node) ? pts.length : pts.length - 1;
        if (pts.length >= 2) {
          for (let i = 0; i < skelCount; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            const hot = selNow.has(i) && selNow.has((i + 1) % pts.length);
            ctx.save();
            ctx.strokeStyle = hot ? SEL : withAlpha(SEL, 0.45);
            ctx.lineWidth = hot ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(snap.panX + (wp.x + a.x) * z, snap.panY + (wp.y + a.y) * z);
            const curved = (a.ox || a.oy) && (b.ix || b.iy);
            if (curved) {
              ctx.bezierCurveTo(
                snap.panX + (wp.x + a.x + (a.ox || 0)) * z,
                snap.panY + (wp.y + a.y + (a.oy || 0)) * z,
                snap.panX + (wp.x + b.x + (b.ix || 0)) * z,
                snap.panY + (wp.y + b.y + (b.iy || 0)) * z,
                snap.panX + (wp.x + b.x) * z,
                snap.panY + (wp.y + b.y) * z,
              );
            } else {
              ctx.lineTo(snap.panX + (wp.x + b.x) * z, snap.panY + (wp.y + b.y) * z);
            }
            ctx.stroke();
            ctx.restore();
          }
        }
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const px = snap.panX + (wp.x + p.x) * z;
          const py = snap.panY + (wp.y + p.y) * z;
          const isSelected = selNow.has(i);

          // Bézier tangent handles: only show for selected vertices (or when dragging) to keep canvas clean
          if (isSelected) {
            ctx.save();
            ctx.strokeStyle = withAlpha(SEL, 0.75);
            ctx.lineWidth = 1;
            if (p.ix != null && p.iy != null && (p.ix !== 0 || p.iy !== 0)) {
              const hx = px + p.ix * z;
              const hy = py + p.iy * z;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(hx, hy);
              ctx.stroke();
              ctx.fillStyle = INK;
              ctx.strokeStyle = SEL;
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
              ctx.fillStyle = INK;
              ctx.strokeStyle = SEL;
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
            ctx.fillStyle = isSelected ? SEL_GLOW : withAlpha(SEL, 0.25);
            ctx.beginPath();
            ctx.arc(px, py, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = SEL;
            ctx.strokeStyle = INK;
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
            ctx.fillStyle = isSelected ? SEL : INK;
            ctx.strokeStyle = isSelected ? INK : SEL;
            ctx.lineWidth = isSelected ? 1.5 : 1.25;
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }

        ctx.restore();
        const box = vecSubTool === "select" ? pointBox(root, vecEdit, snap.vecPoints ?? []) : null;
        if (box) {
          const hs = pointBoxHandles(box.bounds, z);
          ctx.save();
          ctx.strokeStyle = SEL;
          ctx.fillStyle = INK;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(snap.panX + hs[0][0] * z, snap.panY + hs[0][1] * z, (hs[4][0] - hs[0][0]) * z, (hs[4][1] - hs[0][1]) * z);
          ctx.setLineDash([]);
          for (const [x, y] of hs) {
            ctx.fillRect(snap.panX + x * z - 3, snap.panY + y * z - 3, 6, 6);
            ctx.strokeRect(snap.panX + x * z - 3, snap.panY + y * z - 3, 6, 6);
          }
          const pointRotation = drag.current?.mode === "vecResize" && drag.current.id === vecEdit
            ? drag.current.rotationDeg
            : undefined;
          const rotationDrag = drag.current?.mode === "vecResize" && drag.current.id === vecEdit ? drag.current : null;
          if (pointRotation != null && rotationDrag?.currentX != null && rotationDrag.currentY != null) {
            const label = `${pointRotation > 0 ? "+" : ""}${pointRotation}°`;
            ctx.font = "500 11px Inter, system-ui";
            const bw = ctx.measureText(label).width + 12;
            const bx = snap.panX + rotationDrag.currentX * z + 12;
            const by = snap.panY + rotationDrag.currentY * z - 24;
            ctx.fillStyle = SEL;
            if (typeof ctx.roundRect === "function") {
              ctx.beginPath();
              ctx.roundRect(bx, by, bw, 20, 4);
              ctx.fill();
            } else ctx.fillRect(bx, by, bw, 20);
            ctx.fillStyle = INK;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, bx + bw / 2, by + 10);
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
          }
          ctx.restore();
        }
      }
    }

    if (lassoPath.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(snap.panX + lassoPath[0].x * z, snap.panY + lassoPath[0].y * z);
      for (let i = 1; i < lassoPath.length; i++)
        ctx.lineTo(snap.panX + lassoPath[i].x * z, snap.panY + lassoPath[i].y * z);
      ctx.closePath();
      ctx.fillStyle = withAlpha(SEL, 0.08);
      ctx.fill();
      ctx.strokeStyle = SEL;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.restore();
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
          ctx.fillStyle = withAlpha(SEL, 0.08);
          ctx.strokeStyle = withAlpha(SEL, 0.4);
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
        ctx.strokeStyle = GUIDE;
        ctx.fillStyle = GUIDE;
        ctx.lineWidth = 1;
        ctx.font = "500 10px Inter, system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const drawBadge = (label: string, x: number, y: number) => {
          const bw = ctx.measureText(label).width + 8;
          ctx.fillStyle = GUIDE;
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(x - bw / 2, y - 7, bw, 14, 3);
            ctx.fill();
          } else ctx.fillRect(x - bw / 2, y - 7, bw, 14);
          ctx.fillStyle = INK;
          ctx.fillText(label, x, y);
          ctx.fillStyle = GUIDE;
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
      ctx.fillStyle = SEL_WASH;
      ctx.strokeStyle = SEL;
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
        ctx.strokeStyle = INK;
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
          const dpr = window.devicePixelRatio || 1;
          const d = ctx.getImageData(Math.floor(cx * dpr), Math.floor(cy * dpr), 1, 1).data;
          const hex = toHex(d[0], d[1], d[2]);
          eyedropPixel.current = { x: cursorPos.x, y: cursorPos.y, hex };
          const loupeR = 34;
          const loupeX = cx;
          const loupeY = Math.max(loupeR + 10, cy - 50);

          ctx.save();
          ctx.beginPath();
          ctx.arc(loupeX, loupeY, loupeR, 0, Math.PI * 2);
          ctx.fillStyle = hex;
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = INK;
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

          // The active eyedropper color model drives the live value badge.
          const rgb = parseHex(hex);
          const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
          const hsb = rgbToHsv(rgb.r, rgb.g, rgb.b);
          const readout = eyedropModel === "hex"
            ? hex.toUpperCase()
            : eyedropModel === "rgb"
              ? `R ${rgb.r} G ${rgb.g} B ${rgb.b}`
              : eyedropModel === "hsl"
                ? `H ${Math.round(hsl.h)}° S ${Math.round(hsl.s * 100)}% L ${Math.round(hsl.l * 100)}%`
                : `H ${Math.round(hsb.h)}° S ${Math.round(hsb.s * 100)}% B ${Math.round(hsb.v * 100)}%`;
          ctx.fillStyle = CHIP;
          ctx.font = "bold 10px monospace";
          const tw = Math.max(60, ctx.measureText(readout).width + 14);
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
          ctx.fillStyle = INK;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(readout, loupeX, by + th / 2);
          ctx.restore();
        } catch {
          // ignore tainted canvas
        }
      }
    }
    // Crop tool overlay, painted last: the faded full image, the blue crop
    // window (the layer box), and eight handles.
    if (cropId && !snap.presentFrame) {
      const wp = worldPos(root, cropId);
      const cn = wp?.node;
      const cim = cn?.imageSrc ? imgs.current.get(cn.imageSrc) : undefined;
      if (wp && cn && cn.visible && cim?.complete && cim.naturalWidth) {
        const bsx = snap.panX + wp.x * z;
        const bsy = snap.panY + wp.y * z;
        const bsw = cn.w * z;
        const bsh = cn.h * z;
        const cropSource = processImage(cim, cn);
        const ciw = typeof HTMLCanvasElement !== "undefined" && cropSource instanceof HTMLCanvasElement
          ? cropSource.width
          : cim.naturalWidth;
        const cih = typeof HTMLCanvasElement !== "undefined" && cropSource instanceof HTMLCanvasElement
          ? cropSource.height
          : cim.naturalHeight;
        const crect = initialCropRect(cn.imageCrop, ciw, cih, cn.w, cn.h);
        const full = cropFullExtent({ x: bsx, y: bsy, w: bsw, h: bsh }, crect);
        const ccx = bsx + bsw / 2;
        const ccy = bsy + bsh / 2;
        ctx.save();
        if (cn.rotation || cn.flipH || cn.flipV) {
          ctx.translate(ccx, ccy);
          if (cn.rotation) ctx.rotate((cn.rotation * Math.PI) / 180);
          if (cn.flipH || cn.flipV) ctx.scale(cn.flipH ? -1 : 1, cn.flipV ? -1 : 1);
          ctx.translate(-ccx, -ccy);
        }
        // Dimmed surround with the window cut out (a huge rect covers the
        // viewport under any rotation), then the faded full image.
        const dd = Math.hypot(w, h);
        ctx.fillStyle = SCRIM;
        ctx.beginPath();
        ctx.rect(ccx - dd, ccy - dd, dd * 2, dd * 2);
        ctx.rect(bsx, bsy, bsw, bsh);
        ctx.fill("evenodd");
        ctx.save();
        ctx.globalAlpha = 0.5;
        const cropRotation = ((cn.imageRot % 360) + 360) % 360;
        if (cropSource !== cim) {
          // Real Canvas2D: use the exact rotated/adjusted raster the fill uses.
          ctx.drawImage(cropSource, full.x, full.y, full.w, full.h);
        } else if (cropRotation) {
          // Lightweight test canvases may not provide an offscreen 2D context;
          // preserve the visible crop geometry with a transformed source draw.
          ctx.translate(full.x + full.w / 2, full.y + full.h / 2);
          if (cropRotation === 90 || cropRotation === 270) {
            ctx.rotate((cropRotation * Math.PI) / 180);
            const dw = full.h;
            const dh = full.w;
            ctx.drawImage(cim, -dw / 2, -dh / 2, dw, dh);
          } else {
            // Match post-rotation scaling of the materialized raster.
            ctx.scale(full.w / ciw, full.h / cih);
            ctx.rotate((cropRotation * Math.PI) / 180);
            ctx.drawImage(cim, -cim.naturalWidth / 2, -cim.naturalHeight / 2);
          }
        } else {
          ctx.drawImage(cim, full.x, full.y, full.w, full.h);
        }
        ctx.restore();
        const rotateGap = 14;
        const rotatePoints: [number, number][] = [
          [full.x - rotateGap, full.y - rotateGap],
          [full.x + full.w + rotateGap, full.y - rotateGap],
          [full.x + full.w + rotateGap, full.y + full.h + rotateGap],
          [full.x - rotateGap, full.y + full.h + rotateGap],
        ];
        for (const [rx, ry] of rotatePoints) {
          ctx.beginPath();
          ctx.arc(rx, ry, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.strokeStyle = TARGET;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.strokeStyle = TARGET;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bsx, bsy, bsw, bsh);
        for (const hh of cropHandleRects({ x: bsx, y: bsy, w: bsw, h: bsh }, 8)) {
          ctx.fillStyle = TARGET;
          ctx.fillRect(hh.x, hh.y, 8, 8);
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1;
          ctx.strokeRect(hh.x, hh.y, 8, 8);
        }
        ctx.restore();
      }
    }
    // Place-image badge at the cursor: how many are left to place.
    if (placing && cursorPos) {
      const r = wrap.current?.getBoundingClientRect();
      if (r) {
        const left = placing.srcs.length - placing.i;
        const label = left === 1 ? "Click to place · Esc to stop" : `${left} to place · click · Esc to stop`;
        ctx.save();
        ctx.font = "500 11px Inter, system-ui";
        const tw = ctx.measureText(label).width + 16;
        const bx = cursorPos.x - r.left + 14;
        const by = cursorPos.y - r.top + 14;
        ctx.fillStyle = CHIP;
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(bx, by, tw, 22, 5);
          ctx.fill();
        } else ctx.fillRect(bx, by, tw, 22);
        ctx.fillStyle = CHIP_INK;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, bx + 8, by + 11);
        ctx.restore();
      }
    }
  }, [snap, band, edit, engine, theme, chromePref, draft, vecEdit, vecSubTool, hoverId, panelHover, ghost, guides, gapBadges, smartGaps, dropHint, altMeasure, protoDrag, selectedConn, animFrame, closeHint, rotTarget, addPt, cursorPos, cropId, placing, fontRevision, cutLine, lassoPath, widthSel, widthHover, eyedropModel]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return {
      x: (cx - r.left - snap.panX) / snap.zoom,
      y: (cy - r.top - snap.panY) / snap.zoom,
    };
  };
  const completeEyedrop = (clientX: number, clientY: number, modifiers: { shiftKey?: boolean; create?: boolean }) => {
    const canvas = ref.current;
    const rect = canvas?.getBoundingClientRect();
    const cached = eyedropPixel.current;
    const hasCachedPixel = !!cached && Math.hypot(cached.x - clientX, cached.y - clientY) <= 2;
    let hasPixel = hasCachedPixel;
    let hex = hasCachedPixel && cached ? cached.hex : "#000000";
    if (canvas && rect && !hasCachedPixel) {
      const dpr = window.devicePixelRatio || 1;
      const px = Math.floor((clientX - rect.left) * dpr);
      const py = Math.floor((clientY - rect.top) * dpr);
      const ctx = getCanvas2dContext(canvas);
      if (ctx) {
        try {
          const pixel = ctx.getImageData(px, py, 1, 1).data;
          hex = toHex(pixel[0], pixel[1], pixel[2]);
          hasPixel = true;
        } catch {
          // Fall through to the topmost layer's stored paint below.
        }
      }
    }
    const root = snap.pages[snap.page].root;
    const world = toWorld(clientX, clientY);
    const hit = hitTest(root, world.x, world.y, { deep: true });
    if (!hasPixel && hit?.fill) {
      const fallback = parseHex(hit.fill);
      hex = toHex(fallback.r, fallback.g, fallback.b);
    }
    const source = eyedropSourceForNode(hit ?? null, snap, hex);
    const callback = takeEyedrop();
    eyedropPixel.current = null;
    callback?.(hex, { shiftKey: !!modifiers.shiftKey, create: !!modifiers.create, source });
    toast(`Sampled ${hex.toUpperCase()}`);
  };

  /**
   * The frame a drop would land in: the deepest frame under the point that may
   * take children. Instances refuse (their structure belongs to the main
   * component) and locked frames refuse, so the search climbs past them to an
   * enclosing frame, if there is one.
   */
  const dropTargetFrame = (root: XNode, wx: number, wy: number, skip: Set<string>): XNode | null => {
    let frame = deepestFrame(root, wx, wy, skip);
    while (frame) {
      const bad =
        isInstanceMember(root, frame.id) ||
        (!!frame.componentId && !frame.isComponent) ||
        isEffectivelyLocked(root, frame.id);
      if (!bad) return frame;
      let q = findParent(root, frame.id);
      while (q && q !== root && q.kind !== "frame") q = findParent(root, q.id);
      frame = q && q !== root ? q : null;
    }
    return null;
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
      if (!allowTopologyEdit(engine, hit.id)) return;
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
    pointerClient.current = { x: e.clientX, y: e.clientY };
    if (dropHint) setDropHint(null);
    if (edit && (e.target as HTMLElement).closest(".text-edit, .text-edit-frame")) return;
    if (e.button === 2) return;
    if (eyedropArmed()) {
      completeEyedrop(e.clientX, e.clientY, {
        shiftKey: e.shiftKey,
        create: e.shiftKey && (e.metaKey || e.ctrlKey),
      });
      e.preventDefault();
      return;
    }
    // Frame quick-add badges: one on each of the four edge midpoints. Left/right
    // place horizontally, top/bottom vertically; ⌥ places a blank same-size
    // frame instead of duplicating. Per Figma's Frames article the plus nudges
    // neighbouring frames over to make room; that nudging is handled by
    // duplicate's smart-duplicate cascade when applicable, and a section parent
    // auto-grows elsewhere.
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
          const zc = snap.zoom;
          const qx = snap.panX + qb.x * zc;
          const qy = snap.panY + qb.y * zc;
          const qw = qb.w * zc;
          const qh = qb.h * zc;
          const cxH = qx + qw / 2;
          const cyV = qy + qh / 2;
          const hits: Array<{ dx: number; dy: number }> = [];
          if (Math.hypot(px - qx, py - cyV) <= 11) hits.push({ dx: -(qb.w + 24), dy: 0 });           // left
          if (Math.hypot(px - (qx + qw), py - cyV) <= 11) hits.push({ dx: qb.w + 24, dy: 0 });       // right
          if (Math.hypot(px - cxH, py - qy) <= 11) hits.push({ dx: 0, dy: -(qb.h + 24) });           // top
          if (Math.hypot(px - cxH, py - (qy + qh)) <= 11) hits.push({ dx: 0, dy: qb.h + 24 });       // bottom
          if (hits.length) {
            e.preventDefault();
            const { dx, dy } = hits[0];
            const f = qf.node;
            if (e.altKey) {
              const par = findParent(qroot, f.id);
              engine.dispatch({
                type: "add",
                kind: "frame",
                x: f.x + dx,
                y: f.y + dy,
                w: f.w,
                h: f.h,
                parent: par && par !== qroot ? par.id : undefined,
                extra: { name: "Frame" },
              });
            } else {
              engine.dispatch({ type: "select", ids: [f.id] });
              engine.dispatch({ type: "duplicate", dx, dy });
            }
            return;
          }
        }
      }
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
              // §23 PT-004: the press pair fires around the click, overlay or canvas.
              if (n) runTrigger(overlayNode, n.id, "mouseDown");
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
      if (n) runTrigger(root, n.id, "mouseDown");
      if (n) runTrigger(root, n.id, "onClick");
      return;
    }
    if (snap.tool === "eraser") {
      const wpt = toWorld(e.clientX, e.clientY);
      // Phase 10: Collect the eraser stroke path for WASM finalization on up.
      // Find the target node first so we can hand it to Rust on pointer-up.
      const eraseRoot = snap.pages[snap.page].root;
      const hit = hitTest(eraseRoot, wpt.x, wpt.y, { deep: true });
      if (hit && !hit.locked && allowTopologyEdit(engine, hit.id)) {
        eraserPath.current = { points: [[wpt.x, wpt.y]], targetId: hit.id };
      }
      // Also fire the immediate TS erase for visual feedback during the drag
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
      // Phase 9: Alt/Option-click on an existing anchor converts corner↔smooth.
      // This works in both vector-edit mode and when a vector is selected with
      // the pen tool. The conversion toggles between a straight segment (LineTo)
      // and a curved one (CurveTo with auto-placed handles at 1/3rds).
      if (e.altKey && !penBranch.current && !draft.length) {
        const targetId = vecEdit ?? (snap.selection.length === 1 ? snap.selection[0] : null);
        if (targetId) {
          const loc = worldPos(rootForPen, targetId);
          if (loc && !loc.node.locked && (loc.node.kind === "vector" || loc.node.kind === "boolean")) {
            const epts = loc.node.path.length ? loc.node.path : shapePoly(loc.node);
            const elocal = nodeLocalPoint(wpt.x, wpt.y, loc.x, loc.y, loc.node);
            // Find the nearest anchor
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < epts.length; i++) {
              const v = epts[i];
              const d = Math.hypot(elocal.x - v.x, elocal.y - v.y);
              if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
              }
            }
            if (bestIdx >= 0 && bestDist < 12 / snap.zoom) {
              // Dispatch corner↔smooth conversion
              engine.dispatch({
                type: "convertAnchor",
                id: targetId,
                anchorIndex: bestIdx,
              });
              toast(bestDist < 6 / snap.zoom ? "Point converted (corner↔smooth)" : "Point converted");
              return;
            }
          }
        }
      }
      // A branch is anchored on a vertex of the selected vector, so the pen can
      // keep drawing in that shape instead of starting a second one. Everywhere
      // else on that shape's outline, a pen click adds an anchor to it (Figma),
      // and inside a path edit it adds one to the path being edited.
      //
      // One measurement serves the "+" preview and this click —
      // `vectorAddPointTarget` — so an affordance is never offered where the
      // press would refuse to insert, and the anchor always lands on the point
      // the preview showed. Vertices still fall through to branch-drawing below.
      if (!penBranch.current && !draft.length) {
        const targetId = vecEdit ?? (snap.selection.length === 1 ? snap.selection[0] : null);
        const loc = targetId ? worldPos(rootForPen, targetId) : null;
        if (targetId && loc) {
          const elocal = nodeLocalPoint(wpt.x, wpt.y, loc.x, loc.y, loc.node);
          const over = vectorAddPointTarget(rootForPen, targetId, elocal, snap.zoom, {
            edited: vecEdit === targetId,
            vertexPx: vecEdit === targetId ? VERTEX_PRIORITY_PX.edit : VERTEX_PRIORITY_PX.pen,
          });
          if (over) {
            if (!allowTopologyEdit(engine, targetId)) return;
            const epts = loc.node.path.length ? loc.node.path : shapePoly(loc.node);
            const res = insertPointOnPath(epts, elocal.x, elocal.y, effClosed(loc.node), ADD_POINT_TOL_PX / snap.zoom);
            if (res) {
              engine.dispatch({
                type: "insertPointOnPath",
                id: targetId,
                x: elocal.x,
                y: elocal.y,
                maxDist: ADD_POINT_TOL_PX / snap.zoom,
              });
              vecPt.current = res.insertedIndex;
              setVecEdit(targetId, res.insertedIndex);
              toast(vecEdit ? "Point added on path" : "Point added on segment");
              return;
            }
          }
        }
      }

      if (!penBranch.current && !draft.length && snap.selection.length === 1) {
        const sel = find(rootForPen, snap.selection[0]);
        const branchable =
          sel && !sel.locked && (sel.kind === "vector" ||
            sel.kind === "rect" || sel.kind === "ellipse" || sel.kind === "poly" ||
            sel.kind === "star" || sel.kind === "line" || sel.kind === "arrow");
        if (branchable && sel) {
          const src = sel.path.length ? sel.path : shapePoly(sel);
          const vn = sel.vectorNetwork ?? pathToVectorNetwork(src, effClosed(sel));
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
          commitPathWasm(draft, true);
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
    if (e.button === 1 || snap.tool === "hand" || space.current) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, wx: 0, wy: 0 };
      return;
    }
    const wpt = toWorld(e.clientX, e.clientY);
    const root = snap.pages[snap.page].root;
    if (placing && e.button === 0) {
      placeQueued(wpt);
      return;
    }
    if (cropId && snap.tool === "select" && e.button === 0) {
      const wp = worldPos(root, cropId);
      const cn = wp?.node;
      const dims = cn && cn.visible ? cropImageDims(cn) : null;
      if (wp && cn && cn.visible && (cn.imageCrop || dims)) {
        const zc = snap.zoom;
        const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, cn);
        // Handles are hit-tested in the layer's LOCAL space: `local` is
        // rotation/unflip-corrected layer-local, so the rects must not carry
        // the world offset (world rects never met local coords for a layer
        // anywhere but the origin — every handle press fell through to a pan).
        const hs = cropHandleRects({ x: 0, y: 0, w: cn.w, h: cn.h }, 10 / zc);
        const hitH = hs.find(
          (h) => local.x >= h.x && local.x <= h.x + 10 / zc && local.y >= h.y && local.y <= h.y + 10 / zc,
        );
        const start = cn.imageCrop
          ? normalizeCropRect(cn.imageCrop)
          : coverCrop(dims!.iw, dims!.ih, cn.w, cn.h);
        const full = cropFullExtent({ x: 0, y: 0, w: cn.w, h: cn.h }, start);
        const rotateGap = 14 / zc;
        const rotatePoints = [
          [full.x - rotateGap, full.y - rotateGap],
          [full.x + full.w + rotateGap, full.y - rotateGap],
          [full.x + full.w + rotateGap, full.y + full.h + rotateGap],
          [full.x - rotateGap, full.y + full.h + rotateGap],
        ];
        const rotatePoint = rotatePoints.find(([rx, ry]) => Math.hypot(local.x - rx, local.y - ry) <= 9 / zc);
        if (rotatePoint) {
          const cx = full.x + full.w / 2;
          const cy = full.y + full.h / 2;
          engine.dispatch({ type: "begin" });
          drag.current = {
            mode: "cropRotate", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
            id: cropId, origRotation: cn.imageRot ?? 0,
            startAngle: Math.atan2(local.y - cy, local.x - cx), cx, cy,
          };
          return;
        }
        const edgeBand = 8 / zc;
        let imageEdge: "n" | "e" | "s" | "w" | undefined;
        if (full.x < -edgeBand && Math.abs(local.x - full.x) <= edgeBand && local.y >= full.y && local.y <= full.y + full.h) imageEdge = "w";
        else if (full.x + full.w > cn.w + edgeBand && Math.abs(local.x - (full.x + full.w)) <= edgeBand && local.y >= full.y && local.y <= full.y + full.h) imageEdge = "e";
        else if (full.y < -edgeBand && Math.abs(local.y - full.y) <= edgeBand && local.x >= full.x && local.x <= full.x + full.w) imageEdge = "n";
        else if (full.y + full.h > cn.h + edgeBand && Math.abs(local.y - (full.y + full.h)) <= edgeBand && local.x >= full.x && local.x <= full.x + full.w) imageEdge = "s";
        if (imageEdge) {
          engine.dispatch({ type: "begin" });
          drag.current = {
            mode: "cropScale", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
            id: cropId, cropScaleEdge: imageEdge, cropStart: start, cropLX: local.x, cropLY: local.y,
          };
          return;
        }
        if (hitH) {
          cropZoomBase.current = { ...start };
          setCropZoom(100);
          engine.dispatch({ type: "begin" });
          drag.current = {
            mode: "crop", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
            id: cropId, cropHandle: hitH.handle, cropStart: start,
          };
          return;
        }
        if (local.x >= 0 && local.x <= cn.w && local.y >= 0 && local.y <= cn.h) {
          cropZoomBase.current = { ...start };
          setCropZoom(100);
          engine.dispatch({ type: "begin" });
          drag.current = {
            mode: "cropMove", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
            id: cropId, cropLX: local.x, cropLY: local.y, cropStart: start,
          };
          return;
        }
      }
      // Outside the crop window: apply and let the click through — ending the
      // session first so the click's own gesture cannot nest inside it.
      applyCrop();
    }
    // Editing one text layer and pressing on another starts editing that one
    // instead: the blur still to come commits the old copy (re-hug
    // included), then opens the new editor over the press. No drag starts.
    if (edit && snap.tool === "select" && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const hitT = hitTest(root, wpt.x, wpt.y, { deep: true });
      if (hitT && hitT.kind === "text" && hitT.id !== edit.id && !hitT.locked && hitT.visible) {
        editSwitch.current = hitT.id;
        engine.dispatch({ type: "select", ids: [hitT.id] });
        return;
      }
    }
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
    // Vector-edit Lasso is a direct drag gesture: it does not open an undo
    // transaction because it changes only the editor's ephemeral point set.
    if (vecEdit && vecSubTool === "lasso" && snap.tool === "select" && e.button === 0) {
      const initial = [wpt];
      drag.current = {
        mode: "vecLasso", id: vecEdit, sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
        lassoPoints: initial,
        lassoOperation: e.altKey ? "subtract" : e.shiftKey ? "add" : "replace",
      };
      setLassoPath(initial);
      e.preventDefault();
      return;
    }
    // Point-box resize is separate from anchor movement and layer resize.
    if (vecEdit && vecSubTool === "select" && snap.tool === "select") {
      const box = pointBox(root, vecEdit, snap.vecPoints ?? []);
      const corner = box ? pointBoxHit(box.bounds, wpt.x, wpt.y, snap.zoom) : -1;
      if (box && corner >= 0) {
        engine.dispatch({ type: "begin" });
        drag.current = { mode: "vecResize", id: vecEdit, corner, sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
          bounds: box.bounds, origNetwork: box.network, networkIndices: box.indices,
          startAngle: Math.atan2(wpt.y - (box.bounds.y + box.bounds.h / 2), wpt.x - (box.bounds.x + box.bounds.w / 2)) };
        return;
      }
    }
    // Multi-selection: hit-test the combined bounding box's handles first, so a
    // group of layers can be scaled and rotated as one.
    if (snap.selection.length > 1 && (snap.tool === "select" || snap.tool === "scale")) {
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
          if (d >= 8 && d <= 22) {
            if (snap.selection.every((id) => isEffectivelyLocked(root, id))) {
              toast("Locked · ⇧⌘L to unlock");
              return;
            }
            engine.dispatch({ type: "begin" });
            const startAngle = Math.atan2(py - bcy, px - bcx);
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
            if (snap.tool === "scale" && snap.selection.some((id) => insideInstance(root, id))) {
              toast("Not scalable · this layer is inside an instance");
              return;
            }
            if (snap.selection.every((id) => isEffectivelyLocked(root, id))) {
              toast("Locked · ⇧⌘L to unlock");
              return;
            }
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
        // Smart-selection gap handles sit between the layers of a 1D run and
        // take priority over the empty-canvas marquee, the way the article
        // describes them ("hover over your Smart selection, additional pink
        // handles will appear between each layer … click and drag the handle
        // to adjust the space between layers"). The pointer is in screen
        // space, so the world-space midpoint is projected first.
        for (const g of smartGaps) {
          // A row's handle sits at (gap midpoint, band center); a column's is
          // the other way round, the same way the paint reads them.
          const gx = snap.panX + (g.axis === "x" ? g.at : g.cross) * z;
          const gy = snap.panY + (g.axis === "x" ? g.cross : g.at) * z;
          if (Math.hypot(px - gx, py - gy) < 10) {
            if (snap.selection.every((id) => isEffectivelyLocked(root, id))) {
              toast("Locked · ⇧⌘L to unlock");
              return;
            }
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "smartGap",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              smartGap: g.size,
              smartSX: g.axis === "x" ? wpt.x : wpt.y,
              axis: g.axis,
            };
            return;
          }
        }
      }
    }
    // Run 23 — a press on a width point of the selected stroke claims the
    // pointer (⇧ toggles the point instead of dragging); a press anywhere
    // else along an eligible stroke — but only while the pink preview is
    // showing — arms a width-point add that fires on a clean click, so a
    // drag still moves the layer as before.
    if (snap.tool === "select" && !vecEdit && e.button === 0 && snap.selection.length === 1) {
      const wid = snap.selection[0];
      const wn = worldPos(root, wid);
      if (wn) {
        const lx = wpt.x - wn.x;
        const ly = wpt.y - wn.y;
        const proj = projectToPath(wn.node.path, wn.node.closed, lx, ly);
        const tol = Math.max(6, (wn.node.strokeWidth || 1) / 2 + 4) / snap.zoom;
        if (proj && proj.dist <= tol) {
          if (!(widthEditOk(wn.node) && allowTopologyEdit(engine, wid))) {
            // Dashed, branched, patterned, brush… — say why, then carry on:
            // the layer must still move under the press.
            const reason = variableWidthBlockReason(wn.node);
            if (reason) toast(reason);
          } else {
            const stations = widthProfileStations(wn.node.path, wn.node.closed, normalizeWidthProfile(wn.node.strokeWidthProfile));
            let wi = -1;
            let bd = 7 / snap.zoom;
            for (let i = 0; i < stations.length; i++) {
              const dd = Math.hypot(lx - stations[i].x, ly - stations[i].y);
              if (dd < bd) {
                bd = dd;
                wi = i;
              }
            }
            if (wi >= 0) {
              if (e.shiftKey) {
                setWidthSel((prev) => (prev.includes(wi) ? prev.filter((k) => k !== wi) : [...prev, wi]));
              } else {
                const wSelNow = widthSel.length > 1 && widthSel.includes(wi) ? [...widthSel] : [wi];
                setWidthSel(wSelNow);
                engine.dispatch({ type: "begin" });
                drag.current = {
                  mode: "widthPt",
                  sx: e.clientX,
                  sy: e.clientY,
                  wx: wpt.x,
                  wy: wpt.y,
                  id: wid,
                  wOrig: normalizeWidthProfile(wn.node.strokeWidthProfile),
                  wSel: wSelNow,
                };
              }
              return;
            }
            if (widthHover && widthHover.id === wid) {
              pendingWidth.current = { sx: e.clientX, sy: e.clientY, id: wid, t: widthHover.t, x: widthHover.x, y: widthHover.y };
            }
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
        const gt = !isEffectivelyLocked(root, wp.node.id) ? gradTarget(wp.node) : null;
        if (gt) {
          const ax = sx + gt.gx * wp.node.w * z;
          const ay = sy + gt.gy * wp.node.h * z;
          const bx = sx + gt.hx * wp.node.w * z;
          const by = sy + gt.hy * wp.node.h * z;
          // Colour-stop hit areas outrank endpoints, resize handles, and the
          // layer body. A dragged stop is clamped between its neighbours so it
          // remains the same stop even when it is pulled all the way against
          // one of them.
          for (let i = 0; i < gt.stops.length; i++) {
            const stop = gt.stops[i];
            if (stop.position <= 0.001 || stop.position >= 0.999) continue;
            const x = ax + (bx - ax) * stop.position;
            const y = ay + (by - ay) * stop.position;
            if (Math.hypot(px - x, py - y) < 9) {
              engine.dispatch({ type: "begin" });
              drag.current = {
                mode: "gradStop",
                sx: e.clientX,
                sy: e.clientY,
                wx: wpt.x,
                wy: wpt.y,
                id: wp.node.id,
                gindex: gt.index,
                gradStop: i,
                gradStopMin: gt.stops[i - 1]?.position ?? 0,
                gradStopMax: gt.stops[i + 1]?.position ?? 1,
              };
              return;
            }
          }
          if (Math.hypot(px - ax, py - ay) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "g", gindex: gt.index };
            return;
          }
          if (Math.hypot(px - bx, py - by) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "h", gindex: gt.index };
            return;
          }
          // Radial focal ring: checked after the endpoints, so the filled
          // centre dot (r8) still wins while the two coincide — the ring's
          // outer reach (13px) is what separates them on first contact.
          if (gt.type === "radial") {
            const fx = sx + gt.fx * wp.node.w * z;
            const fy = sy + gt.fy * wp.node.h * z;
            if (Math.hypot(px - fx, py - fy) <= 13) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "f", gindex: gt.index };
              return;
            }
          }
          // Midpoint handles: the small squares between adjacent stops.
          for (let i = 0; i < gt.stops.length - 1; i++) {
            const p0 = gt.stops[i].position;
            const p1 = gt.stops[i + 1].position;
            const span = p1 - p0;
            if (span <= 1e-4) continue;
            const m = Math.max(0, Math.min(1, gt.mids?.[i] ?? 0.5));
            const x = ax + (bx - ax) * (p0 + span * m);
            const y = ay + (by - ay) * (p0 + span * m);
            if (Math.hypot(px - x, py - y) < 6) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "gradMid", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, gradMid: i, gindex: gt.index };
              return;
            }
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
          // Sweep, then Start, then Ratio - the arc controls take the press
          // ahead of the box's own resize handles, because the sweep dot sits
          // on the ellipse's edge where a side handle also lives.
          const dot = arcHandlePoints(wp.node, sx, sy, wp.node.w * z, wp.node.h * z).find(
            (h) => Math.hypot(px - h.x, py - h.y) <= 9,
          );
          if (dot) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "arc",
              handle: dot.kind,
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
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
          // Run 22: in cut mode every press on the edited path starts the
          // blade — the release decides between a click split (point /
          // segment) and a drag-across cut. Nothing else in the edit loop
          // may claim the press first: the point handles and the segment
          // insert are exactly what the cut replaces.
          if (vecSubTool === "cut") {
            setCutLine({ x1: wpt.x, y1: wpt.y, x2: wpt.x, y2: wpt.y });
            drag.current = { mode: "vecCut", id: wp.node.id, sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y };
            return;
          }
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const vx = snap.panX + (wp.x + p.x) * z;
            const vy = snap.panY + (wp.y + p.y) * z;
            if ((p.ix || p.iy) && Math.hypot(px - (vx + (p.ix || 0) * z), py - (vy + (p.iy || 0) * z)) < 7) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, handle: "in" };
              return;
            }
            if ((p.ox || p.oy) && Math.hypot(px - (vx + (p.ox || 0) * z), py - (vy + (p.oy || 0) * z)) < 7) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, handle: "out" };
              return;
            }
            // The same radius the "+" preview bows out at, from one constant: the
            // press grabs a point here, so a preview must not promise an insert.
            if (Math.hypot(px - vx, py - vy) < VERTEX_PRIORITY_PX.edit) {
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
            const nextFill = wp.node.fillVisible ? (wp.node.fill || DOC_FILL_NONE) : DOC_FILL_BRAND;
            const vn = wp.node.vectorNetwork || pathToVectorNetwork(wp.node.path.length ? wp.node.path : shapePoly(wp.node), effClosed(wp.node));
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
            const count = effClosed(wp.node) ? npts : npts - 1;
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
            // The insert uses the same tolerance as the "+" preview the pointer
            // has been tracking, so the anchor lands on the mark that was showing.
            const res = insertPointOnPath(pts, local.x, local.y, effClosed(wp.node), ADD_POINT_TOL_PX / snap.zoom);
            if (res) {
              if (!allowTopologyEdit(engine, wp.node.id)) return;
              engine.dispatch({ type: "insertPointOnPath", id: wp.node.id, x: local.x, y: local.y, maxDist: ADD_POINT_TOL_PX / snap.zoom });
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
        // Frames rotate only from the detached top-center handle; their
        // corners remain resize-only. Other layer kinds keep corner rotation.
        // A resize handle always outranks the rotation ring: on a layer with a
        // side under ~44px the edge-midpoint handle sits inside the 8-22px
        // corner ring, and the hover cursor (which tests resize last) already
        // promises a resize there - the press must agree with it.
        const onResizeHandle =
          !vecEdit &&
          hs.some(([hx, hy], i) => {
            if ((wp.node.kind === "line" || wp.node.kind === "arrow") && i !== 3 && i !== 7) return false;
            if (wp.node.kind === "text" && wp.node.sizingW === "hug" && wp.node.sizingH === "hug" && i % 2 === 0) return false;
            return Math.hypot(px - hx, py - hy) < 8;
          });
        if (!vecEdit && snap.tool === "select" && (e.metaKey || e.ctrlKey) && (wp.node.imageSrc || wp.node.fillType === "image")) {
          const cropCorner = hs.findIndex(([hx, hy], i) => i % 2 === 0 && Math.hypot(px - hx, py - hy) < 8);
          if (cropCorner >= 0) {
            const dims = cropImageDims(wp.node);
            if (dims) {
              if (isEffectivelyLocked(root, wp.node.id)) {
                toast("Locked · ⇧⌘L to unlock");
                return;
              }
              const start = wp.node.imageCrop
                ? normalizeCropRect(wp.node.imageCrop)
                : coverCrop(dims.iw, dims.ih, wp.node.w, wp.node.h);
              const cropHandles: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
              enterCrop(wp.node.id);
              cropZoomBase.current = { ...start };
              setCropZoom(100);
              drag.current = {
                mode: "crop", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y,
                id: wp.node.id, cropHandle: cropHandles[cropCorner], cropStart: start,
              };
              return;
            }
          }
        }
        if (!vecEdit && !onResizeHandle && rotationHandleHit(wp.node.kind, px, py, sx, sy, nb.w * z, nb.h * z)) {
          if (isEffectivelyLocked(root, wp.node.id)) {
            toast("Locked · ⇧⌘L to unlock");
            return;
          }
          const startAngle = Math.atan2(rawY - cy, rawX - cx);
          // `wp.node.rotation` is the on-page total (ancestors included); the
          // patch below writes the layer's own value, so start from that.
          const ownRotation = find(root, wp.node.id)?.rotation || 0;
          engine.dispatch({ type: "begin" });
          drag.current = {
            mode: "rotate",
            sx: e.clientX,
            sy: e.clientY,
            wx: wpt.x,
            wy: wpt.y,
            orig: { x: nb.x, y: nb.y, w: nb.w, h: nb.h, rotation: ownRotation },
            origLocal: { x: wp.node.x, y: wp.node.y },
            id: wp.node.id,
            startAngle,
            origRotation: ownRotation,
            cx,
            cy,
          };
          return;
        }
        const isLine = wp.node.kind === "line" || wp.node.kind === "arrow";
        const isTextHug = wp.node.kind === "text" && wp.node.sizingW === "hug" && wp.node.sizingH === "hug";
        for (let i = 0; !vecEdit && i < hs.length; i++) {
          if (isLine && i !== 3 && i !== 7) continue;
          if (isTextHug && i % 2 === 0) continue;
          if (Math.hypot(px - hs[i][0], py - hs[i][1]) < 8) {
            // The scale tool ignores layers nested inside an instance; a
            // plain resize is still allowed, because that is an override.
            if (snap.tool === "scale" && insideInstance(root, wp.node.id)) {
              toast("Not scalable · this layer is inside an instance");
              return;
            }
            if (isEffectivelyLocked(root, wp.node.id)) {
              toast("Locked · ⇧⌘L to unlock");
              return;
            }
            drag.current = {
              mode: "resize",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              orig: { x: wp.node.x, y: wp.node.y, w: wp.node.w, h: wp.node.h, rotation: find(root, wp.node.id)?.rotation ?? 0 },
              corner: i,
              id: wp.node.id,
            };
            engine.dispatch({ type: "begin" });
            return;
          }
        }
        // Text-on-path start handle (360039956434): drag it to slide where the
        // text begins along its path.
        if (wp.node.onPath && snap.selection.includes(wp.node.id)) {
          const pgeom = onPathGeometry(snap.pages[snap.page].root, wp.node);
          if (pgeom) {
            const p = walkAt(pgeom.walk, (wp.node.pathStart ?? 0) * pgeom.walk.len);
            const hx = sx + (pgeom.dx + p.x) * z;
            const hy = sy + (pgeom.dy + p.y) * z;
            if (Math.hypot(px - hx, py - hy) < 10) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "pathStart", id: wp.node.id, sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, moved: true };
              return;
            }
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
          for (const pill of autoGapPills(wp.node)) {
            if (gapPillHit(pill, sx, sy, z, px, py)) {
              engine.dispatch({ type: "begin" });
              // origGap seeds from the MEASURED pair distance, not `l.gap`:
              // under Auto the numeric gap says nothing about what is on
              // screen, and the first move must not teleport the spacing.
              drag.current = { mode: "autoGap", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, origGap: pill.gap0, gapAxis: pill.axis };
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

    const hit = e.metaKey || e.ctrlKey
      ? hitTest(root, wpt.x, wpt.y, { deep: true })
      : canvasClickTarget(root, wpt.x, wpt.y, snap.selection);
    // A hovered, unselected ellipse shows its arc controls, so a press on one
    // takes the handle - and selects the layer - instead of starting a move.
    if (hit && hit.kind === "ellipse" && snap.tool === "select" && !vecEdit && !snap.selection.includes(hit.id)) {
      const hp = worldPos(root, hit.id);
      const r = wrap.current!.getBoundingClientRect();
      if (hp) {
        const hb = nodeVisualBounds(hp);
        const z = snap.zoom;
        const hsx = snap.panX + hb.x * z;
        const hsy = snap.panY + hb.y * z;
        const hsw = hb.w * z;
        const hsh = hb.h * z;
        if (hsw >= 36 && hsh >= 36) {
          const rcx = hsx + hsw / 2;
          const rcy = hsy + hsh / 2;
          let px = e.clientX - r.left;
          let py = e.clientY - r.top;
          if (hit.rotation || hit.flipH || hit.flipV) {
            const u = hit.rotation ? unrot(px, py, rcx, rcy, hit.rotation) : { x: px, y: py };
            px = hit.flipH ? rcx - (u.x - rcx) : u.x;
            py = hit.flipV ? rcy - (u.y - rcy) : u.y;
          }
          const dot = arcHandlePoints(hit, hsx, hsy, hsw, hsh).find(
            (h) => Math.hypot(px - h.x, py - h.y) <= 9,
          );
          if (dot) {
            engine.dispatch({ type: "select", ids: [hit.id] });
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "arc",
              handle: dot.kind,
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: hit.id,
            };
            return;
          }
        }
      }
    }
    if (hit) {
      const ids = e.shiftKey
        ? snap.selection.includes(hit.id)
          ? snap.selection.filter((i) => i !== hit.id)
          : [...snap.selection, hit.id]
        // Pressing a member starts moving the existing selection, not just
        // that member. Shift remains the explicit membership toggle.
        : snap.selection.includes(hit.id) ? [...snap.selection] : [hit.id];
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
    pointerClient.current = { x: e.clientX, y: e.clientY };
    if (eyedropArmed() || snap.tool === "eraser" || placing) {
      cursorPosRef.current = { x: e.clientX, y: e.clientY };
      setCursorPos(cursorPosRef.current);
    } else if (cursorPos) {
      cursorPosRef.current = null;
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
        if (prev) {
          const leftRan = runTrigger(root, prev, "mouseLeave");
          // §23 PT-005: an explicit Mouse-leave action wins; otherwise a
          // pending while-hovering return takes the user back to the origin
          // frame (Figma) — but only while still sitting on its destination,
          // so stale pendings never yank the user out of a later screen.
          const hr = hoverReturn.current;
          if (leftRan) hoverReturn.current = null;
          else if (hr && isSelfOrDescendant(root, prev, hr.nodeId)) {
            hoverReturn.current = null;
            if (snap.presentFrame === hr.destId && snap.presentFrame !== hr.fromFrame) {
              runInteraction(
                { trigger: "mouseLeave", action: "navigate", destination: hr.fromFrame, animation: "instant", delay: 0 },
                hr.nodeId,
              );
            }
          }
        }
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
    // Figma's "add an anchor here" state. Two gestures earn it: the pen over a
    // path that is not mid-draft, and point edit hovering a segment. Both the
    // "+" marker and the cursor come out of `vectorAddPointTarget` — the same
    // measurement the click uses — so an affordance is never offered for a point
    // the press would refuse (a locked layer, a branched network, a vertex).
    const addArmed =
      !drag.current &&
      !penDrag.current &&
      !pencil.current &&
      ((snap.tool === "select" && !!vecEdit && vecSubTool === "select" && !e.altKey && !e.metaKey && !e.ctrlKey) ||
        (snap.tool === "pen" && !draft.length && !penBranch.current && !e.altKey));
    {
      let nextAdd: AddPointPreview | null = null;
      if (addArmed) {
        const targetId = vecEdit ?? (snap.selection.length === 1 ? snap.selection[0] : null);
        if (targetId) {
          const awp = worldPos(snap.pages[snap.page].root, targetId);
          if (awp) {
            const awpt = toWorld(e.clientX, e.clientY);
            const local = nodeLocalPoint(awpt.x, awpt.y, awp.x, awp.y, awp.node);
            const hit = vectorAddPointTarget(snap.pages[snap.page].root, targetId, local, snap.zoom, {
              edited: vecEdit === targetId,
              vertexPx: vecEdit === targetId ? VERTEX_PRIORITY_PX.edit : VERTEX_PRIORITY_PX.pen,
            });
            if (hit) nextAdd = hit;
          }
        }
      }
      const same =
        (nextAdd?.id ?? null) === (addPt?.id ?? null) &&
        (nextAdd?.x ?? 0) === (addPt?.x ?? 0) &&
        (nextAdd?.y ?? 0) === (addPt?.y ?? 0);
      if (!same) setAddPt(nextAdd);
    }
    if (!drag.current && !penDrag.current && !pencil.current && snap.tool === "select") {
      if (e.altKey !== altMeasure) setAltMeasure(e.altKey);
      const wpt = toWorld(e.clientX, e.clientY);
      const hit = e.metaKey || e.ctrlKey
        ? hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { deep: true })
        : canvasClickTarget(snap.pages[snap.page].root, wpt.x, wpt.y, snap.selection);
      const id = hit && !snap.selection.includes(hit.id) ? hit.id : "";
      if (id !== hoverId) setHoverId(id);
      // Run 23 — variable-width hover: project the pointer onto the selected
      // stroke and show where a click would add a width point (a ring lands
      // on an existing one). Re-projected every move so it tracks the line.
      const selW = snap.selection.length === 1 ? worldPos(snap.pages[snap.page].root, snap.selection[0]) : null;
      if (selW && widthEditOk(selW.node) && allowTopologyEdit(engine, selW.node.id)) {
        const projW = projectToPath(selW.node.path, selW.node.closed, wpt.x - selW.x, wpt.y - selW.y);
        const tolW = Math.max(6, (selW.node.strokeWidth || 1) / 2 + 4) / snap.zoom;
        if (projW && projW.dist <= tolW) {
          const stations = widthProfileStations(selW.node.path, selW.node.closed, normalizeWidthProfile(selW.node.strokeWidthProfile));
          let wiW: number | null = null;
          let bdW = 7 / snap.zoom;
          for (let i = 0; i < stations.length; i++) {
            const dd = Math.hypot(wpt.x - (selW.x + stations[i].x), wpt.y - (selW.y + stations[i].y));
            if (dd < bdW) {
              bdW = dd;
              wiW = i;
            }
          }
          if (!widthHover || widthHover.id !== selW.node.id || widthHover.t !== projW.t || widthHover.onPoint !== wiW)
            setWidthHover({ id: selW.node.id, t: projW.t, x: projW.x, y: projW.y, onPoint: wiW });
        } else if (widthHover) setWidthHover(null);
      } else if (widthHover) setWidthHover(null);
      // Mirror the mousedown hit-test so the cursor advertises what a press
      // would actually do: resize on a handle, rotate on the rotation target,
      // move over the selection itself.
      const root0 = snap.pages[snap.page].root;
      const r0 = wrap.current?.getBoundingClientRect();
      let next: string | null = null;
      const pointBounds = vecEdit && vecSubTool === "select" ? pointBox(root0, vecEdit, snap.vecPoints ?? []) : null;
      const pointHandle = pointBounds ? pointBoxHit(pointBounds.bounds, wpt.x, wpt.y, snap.zoom) : -1;
      if (pointHandle >= 0)
        next = isPointBoxCorner(pointHandle) && e.shiftKey ? ROT_CURSOR : resizeCursor(pointHandle);
      // The rotation target's hover state is measured in the same pass as its
      // cursor (below), so the two can never disagree about where the target is.
      if (r0 && snap.selection.length && !vecEdit) {
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
          if (bb?.node.flipH) hx = 2 * sx0 + box.w * z - hx;
          if (bb?.node.flipV) hy = 2 * sy0 + box.h * z - hy;
          const hs = handles(sx0, sy0, box.w * z, box.h * z);
          const locked = bb && isEffectivelyLocked(root0, bb.node.id);
          if (!locked && rotationHandleHit(bb?.node.kind ?? "group", hx, hy, sx0, sy0, box.w * z, box.h * z)) {
            next = ROT_CURSOR;
          }
          for (let i = 0; i < hs.length; i++) {
            if (Math.hypot(hx - hs[i][0], hy - hs[i][1]) < 8) {
              next = resizeCursor(visualHandleIndex(i, !!bb?.node.flipH, !!bb?.node.flipV), box.rot);
              break;
            }
          }
          // Gradient controls are direct canvas affordances. Their cursor is
          // deliberately resolved after selection chrome because their press
          // wins over resize/rotate handles in onDown as well.
          if (!locked && bb && snap.selection.length === 1) {
            const gt = gradTarget(bb.node);
            if (gt) {
              const ax = sx0 + gt.gx * bb.node.w * z;
              const ay = sy0 + gt.gy * bb.node.h * z;
              const bx = sx0 + gt.hx * bb.node.w * z;
              const by = sy0 + gt.hy * bb.node.h * z;
              const onStop = gt.stops.some((stop) =>
                stop.position > 0.001 &&
                stop.position < 0.999 &&
                Math.hypot(hx - (ax + (bx - ax) * stop.position), hy - (ay + (by - ay) * stop.position)) < 9,
              );
              const onAxis =
                Math.hypot(hx - ax, hy - ay) < 8 ||
                Math.hypot(hx - bx, hy - by) < 8 ||
                (gt.type === "radial" &&
                  Math.hypot(hx - (sx0 + gt.fx * bb.node.w * z), hy - (sy0 + gt.fy * bb.node.h * z)) <= 13);
              const onMid = gt.stops.some((stop, i) => {
                const other = gt.stops[i + 1];
                if (!other) return false;
                const span = other.position - stop.position;
                if (span <= 1e-4) return false;
                const m = Math.max(0, Math.min(1, gt.mids?.[i] ?? 0.5));
                const pos = stop.position + span * m;
                return Math.hypot(hx - (ax + (bx - ax) * pos), hy - (ay + (by - ay) * pos)) < 6;
              });
              if (onStop) next = "grab";
              else if (onAxis) next = "crosshair";
              else if (onMid) next = "grab";
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
              const horiz = l.direction === "horizontal";
              for (const pill of autoGapPills(bb.node)) {
                if (gapPillHit(pill, sx0, sy0, z, hx, hy)) {
                  // The cursor points along the axis the drag changes: a line
                  // gap drags across the flow, everything else along it.
                  next = (pill.axis === "gap") === horiz ? "col-resize" : "row-resize";
                  break;
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
    } else {
      if (hoverId && snap.tool !== "select") setHoverId("");
    }
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
      // Only the start anchor closes the path — ringing any other anchor
      // promises a join the click cannot keep.
      let hint: number | null = null;
      if (
        draft.length >= 2 &&
        Math.hypot(wpt.x - draft[0].x, wpt.y - draft[0].y) < 14 / snap.zoom
      ) {
        hint = 0;
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
    if (d.mode === "vecLasso") {
      const p = toWorld(e.clientX, e.clientY);
      const points = d.lassoPoints ?? [];
      const last = points[points.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) * snap.zoom >= 2.5) {
        d.lassoPoints = [...points, p];
        setLassoPath(d.lassoPoints);
      }
      return;
    }
    if (d.mode === "vecResize" && d.spaceState && space.current && d.id && d.networkIndices) {
      const p = toWorld(e.clientX, e.clientY);
      const state = d.spaceState;
      state.dx += p.x - state.lastX;
      state.dy += p.y - state.lastY;
      state.lastX = p.x;
      state.lastY = p.y;
      const root = snap.pages[snap.page].root;
      engine.dispatch({ type: "patchVectorNetwork", id: d.id, preserveBounds: true,
        network: translatePointNetwork(root, d.id, state.network, d.networkIndices, state.dx, state.dy) });
      return;
    }
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
              worldGuides(root2, snap.pages[snap.page].guides),
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
        engine.dispatch({ type: "move", ids: sel, dx, dy, world: true });
        d.sx = e.clientX;
        d.sy = e.clientY;
      }
      // The live drop target: the frame under the cursor, and the flow gap the
      // drop would land in. Read off the same snapshot as the snap targets, so
      // it trails the pointer by a frame at most; the drop itself re-reads.
      {
        const wpt = toWorld(e.clientX, e.clientY);
        const r3 = snap.pages[snap.page].root;
        const selNow = engine.snapshot().selection;
        const frame = dropTargetFrame(r3, wpt.x, wpt.y, new Set(selNow));
        const fw = frame ? worldPos(r3, frame.id) : null;
        if (!frame || !fw) {
          if (dropHint) setDropHint(null);
        } else {
          const gap = frame.layout ? flowGapLine(frame, wpt.x - fw.x, wpt.y - fw.y) : null;
          const line = gap
            ? gap.horiz
              ? { horiz: true, at: fw.x + gap.at, from: fw.y + gap.from, to: fw.y + gap.to }
              : { horiz: false, at: fw.y + gap.at, from: fw.x + gap.from, to: fw.x + gap.to }
            : null;
          const same =
            dropHint &&
            dropHint.fx === fw.x &&
            dropHint.fy === fw.y &&
            dropHint.fw === frame.w &&
            dropHint.fh === frame.h &&
            (dropHint.line === null) === (line === null) &&
            (!line ||
              !dropHint.line ||
              (dropHint.line.horiz === line.horiz &&
                dropHint.line.at === line.at &&
                dropHint.line.from === line.from &&
                dropHint.line.to === line.to));
          if (!same) setDropHint({ fx: fw.x, fy: fw.y, fw: frame.w, fh: frame.h, line });
        }
      }
    } else if (d.mode === "multiResize" && d.bounds && d.origs && d.corner != null) {
      const b = toWorld(e.clientX, e.clientY);
      const next = resizeFrom(d.bounds, d.corner, b.x, b.y, {
        aspect: e.shiftKey || snap.tool === "scale",
        fromCenter: e.altKey,
      });
      const mapped = resizeGroupMembers(d.bounds, d.origs, next);
      const rootNow = snap.pages[snap.page].root;
      for (let i = 0; i < d.origs.length; i++) {
        const o = d.origs[i], m = mapped[i];
        // Convert the mapped page-space centre back into the node's parent
        // coordinates. This keeps nested selections correct under rotated or
        // mirrored containers; subtracting page deltas from local x/y does not.
        const pc = worldPointToParent(rootNow, o.id, m.x + m.w / 2, m.y + m.h / 2);
        engine.dispatch({
          type: "resize",
          id: o.id,
          x: pc.x - m.w / 2,
          y: pc.y - m.h / 2,
          w: Math.max(1, m.w),
          h: Math.max(1, m.h),
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
      const rotated = rotateGroupMembers(d.bounds, d.origs, ang);
      const rootNow = snap.pages[snap.page].root;
      for (let i = 0; i < d.origs.length; i++) {
        const o = d.origs[i], m = rotated[i];
        const pc = worldPointToParent(rootNow, o.id, m.x + m.w / 2, m.y + m.h / 2);
        engine.dispatch({ type: "resize", id: o.id, x: pc.x - o.w / 2, y: pc.y - o.h / 2, w: o.w, h: o.h });
        engine.dispatch({
          type: "patch",
          id: o.id,
          patch: { rotation: wrapRotationDeg(Math.round(((o.rotation || 0) + ang * parentHandedness(rootNow, o.id)) * 10) / 10) },
        });
      }
    } else if (d.mode === "cropScale" && d.id && d.cropStart && d.cropScaleEdge && d.cropLX != null && d.cropLY != null) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      const cn = wp?.node;
      if (!wp || !cn) return;
      const wpt = toWorld(e.clientX, e.clientY);
      const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, cn);
      const start = d.cropStart;
      const edge = d.cropScaleEdge;
      const full = cropFullExtent({ x: 0, y: 0, w: cn.w, h: cn.h }, start);
      const delta = edge === "e" ? local.x - d.cropLX : edge === "w" ? d.cropLX - local.x : edge === "s" ? local.y - d.cropLY : d.cropLY - local.y;
      const baseLength = edge === "e" || edge === "w" ? full.w : full.h;
      const factor = Math.max(0.05, 1 + delta / Math.max(1, baseLength));
      const w = start.w / factor;
      const h = start.h / factor;
      const cx = start.x + start.w / 2;
      const cy = start.y + start.h / 2;
      const x = e.altKey ? cx - w / 2 : edge === "w" ? start.x + start.w - w : start.x;
      const y = e.altKey ? cy - h / 2 : edge === "n" ? start.y + start.h - h : start.y;
      cropDirty.current = true;
      engine.dispatch({ type: "patch", id: d.id, patch: { imageCrop: normalizeCropRect({ x, y, w, h }) } });
    } else if (d.mode === "cropRotate" && d.id && d.startAngle != null && d.cx != null && d.cy != null) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      const cn = wp?.node;
      if (!wp || !cn) return;
      const wpt = toWorld(e.clientX, e.clientY);
      const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, cn);
      let delta = Math.atan2(local.y - d.cy, local.x - d.cx) - d.startAngle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      let rotation = (d.origRotation ?? 0) + (delta * 180) / Math.PI;
      if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
      cropDirty.current = true;
      cropZoomBase.current = undefined;
      setCropZoom(100);
      engine.dispatch({ type: "patch", id: d.id, patch: { imageRot: rotation } });
    } else if ((d.mode === "crop" || d.mode === "cropMove") && d.id && d.cropStart) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      const cn = wp?.node;
      if (!wp || !cn) return;
      const wpt = toWorld(e.clientX, e.clientY);
      const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, cn);
      const start = d.cropStart;
      if (d.mode === "cropMove" && d.cropLX != null && d.cropLY != null) {
        // Grab-style: the image follows the pointer, so the window moves
        // against it.
        const du = -(((local.x - d.cropLX) / cn.w) * start.w);
        const dv = -(((local.y - d.cropLY) / cn.h) * start.h);
        cropDirty.current = true;
        engine.dispatch({ type: "patch", id: d.id, patch: { imageCrop: moveCrop(start, du, dv) } });
      } else if (d.mode === "crop" && d.cropHandle) {
        const { u, v } = layerToImage(start, local.x / cn.w, local.y / cn.h);
        cropDirty.current = true;
        engine.dispatch({
          type: "patch",
          id: d.id,
          patch: {
            imageCrop: dragCropHandle(start, d.cropHandle, u, v, {
              // Image aspect is the default; chosen presets stay locked unless
              // the user holds Control/Command to free the drag. Shift forces
              // the selected ratio and Alt mirrors the edit about the centre.
              lockAspect: e.shiftKey || (cropAspect !== "free" && !e.ctrlKey && !e.metaKey),
              aspect: normalizedCropAspect(cropImageDims(cn) ?? { iw: 1, ih: 1 }),
              symmetric: e.altKey,
            }),
          },
        });
      }
    } else if (d.mode === "marquee" && d.id === "erase") {
      const wpt = toWorld(e.clientX, e.clientY);
      // Phase 10: collect the eraser stroke for WASM finalization
      if (eraserPath.current) {
        eraserPath.current.points.push([wpt.x, wpt.y]);
      }
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
      const rootNow = snap.pages[snap.page].root;
      const pagePt = toWorld(e.clientX, e.clientY);
      const current = worldPos(rootNow, d.id);
      // `d.orig` is the layer's own box in its parent's coordinates (what
      // `resize` writes back), so the pointer has to be brought into that same
      // space first: a child of an offset or rotated frame otherwise measures
      // the drag against the page origin and jumps by the parent's offset.
      const raw = worldPointToParent(rootNow, d.id, pagePt.x, pagePt.y);
      const own = find(rootNow, d.id);
      const shape = own ? { ...own, x: d.orig.x, y: d.orig.y, w: d.orig.w, h: d.orig.h } : null;
      const local = shape ? nodeLocalPoint(raw.x, raw.y, d.orig.x, d.orig.y, shape) : { x: raw.x - d.orig.x, y: raw.y - d.orig.y };
      const b = shape ? { x: d.orig.x + local.x, y: d.orig.y + local.y } : raw;
      const node = own;
      // Page-axis snapping only makes sense while the parent's axes are the
      // page's; under a rotated/flipped ancestry the edges being dragged are
      // not page-aligned and a snap would shear the box.
      const parentUpright = (() => {
        const pm = worldDeltaToParent(rootNow, d.id, 1, 0);
        return pm.dx === 1 && pm.dy === 0;
      })();
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
      if (!lock && !e.altKey && !e.metaKey && !e.ctrlKey && current && parentUpright) {
        const worldBox = {
          id: d.id,
          x: current.x + (next.x - node!.x),
          y: current.y + (next.y - node!.y),
          w: next.w,
          h: next.h,
        };
        const r2 = snapResize(
          worldBox,
          d.corner,
          snapTargets.current,
          SNAP_PX / snap.zoom,
          worldGuides(snap.pages[snap.page].root, snap.pages[snap.page].guides),
        );
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
    } else if ((d.mode === "grad" || d.mode === "gradStop" || d.mode === "gradMid") && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const raw = {
          x: local.x / Math.max(1, wp.node.w),
          y: local.y / Math.max(1, wp.node.h),
        };
        const gi = d.gindex ?? -1;
        const gt = gradTarget(wp.node);
        // A paint-stack reorder could change which fill is topmost during a
        // drag. The drag owns the exact fill index it started on, so recover
        // its geometry directly rather than accidentally editing a new top
        // paint.
        if (!gt || gt.index !== gi) return;
        if (d.mode === "gradMid") {
          // The midpoint handle slides the 50/50 blend of its own stop pair
          // along their span; the pair itself never moves.
          const i = d.gradMid;
          if (i == null) return;
          const a = gt.stops[i];
          const b = gt.stops[i + 1];
          if (!a || !b) return;
          const span = b.position - a.position;
          if (span <= 1e-4) return;
          const unclamped = gradientAxisPosition(raw, gt, wp.node, snap.zoom);
          const m = Math.max(0.05, Math.min(0.95, (unclamped - a.position) / span));
          const midpoints = Array.from({ length: gt.stops.length - 1 }, (_, k) => (k === i ? m : gt.mids?.[k] ?? 0.5));
          if (gi < 0) {
            engine.dispatch({ type: "patch", id: d.id, patch: { gradientMidpoints: midpoints } });
          } else {
            const fills = [...(wp.node.fills ?? [])];
            const p = fills[gi];
            if (!p) return;
            fills[gi] = { ...p, midpoints };
            engine.dispatch({ type: "patch", id: d.id, patch: { fills } });
          }
        } else if (d.mode === "gradStop") {
          const index = d.gradStop;
          if (index == null || !gt.stops[index]) return;
          const unclamped = gradientAxisPosition(raw, gt, wp.node, snap.zoom);
          const position = Math.max(d.gradStopMin ?? 0, Math.min(d.gradStopMax ?? 1, unclamped));
          const stops = gt.stops.map((stop, i) => (i === index ? { ...stop, position } : { ...stop }));
          if (gi < 0) {
            engine.dispatch({
              type: "patch",
              id: d.id,
              patch: {
                gradientStops: stops,
                // Keep old two-colour consumers and serializers in sync.
                fill: stops[0].color,
                fillB: stops[stops.length - 1].color,
              },
            });
          } else {
            const fills = [...(wp.node.fills ?? [])];
            const p = fills[gi];
            if (!p) return;
            fills[gi] = { ...p, stops, color: stops[0].color };
            engine.dispatch({ type: "patch", id: d.id, patch: { fills } });
          }
        } else {
          // The focal ring (`f`) pivots around the centre, so an unsnapped
          // shift-constrain rotates the ray centre → focal cleanly.
          const fixed = d.handle === "g" ? { x: gt.hx, y: gt.hy } : { x: gt.gx, y: gt.gy };
          const point = snappedGradientEndpoint(raw, fixed, wp.node, snap.zoom, e.shiftKey);
          if (gi < 0) {
            if (d.handle === "g") engine.dispatch({ type: "patch", id: d.id, patch: { fillGX: point.x, fillGY: point.y } });
            else if (d.handle === "f") engine.dispatch({ type: "patch", id: d.id, patch: { fillFX: point.x, fillFY: point.y } });
            else engine.dispatch({ type: "patch", id: d.id, patch: { fillHX: point.x, fillHY: point.y } });
          } else {
            // The handles grabbed a stacked fill: write its own geometry. The
            // first drag also pins down inherited base geometry explicitly, at
            // the values the handles already showed, so nothing jumps.
            const fills = [...(wp.node.fills ?? [])];
            const p = fills[gi];
            if (!p) return;
            fills[gi] =
              d.handle === "g"
                ? { ...p, gx: point.x, gy: point.y, hx: p.hx ?? wp.node.fillHX ?? 0.5, hy: p.hy ?? wp.node.fillHY ?? 1 }
                : d.handle === "f"
                  ? { ...p, fx: point.x, fy: point.y, gx: p.gx ?? wp.node.fillGX ?? 0.5, gy: p.gy ?? wp.node.fillGY ?? 0 }
                  : { ...p, hx: point.x, hy: point.y, gx: p.gx ?? wp.node.fillGX ?? 0.5, gy: p.gy ?? wp.node.fillGY ?? 0 };
            engine.dispatch({ type: "patch", id: d.id, patch: { fills } });
          }
        }
      }
    } else if (d.mode === "vecResize" && d.id && d.corner != null && d.bounds && d.origNetwork && d.networkIndices) {
      const p = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      let network: VectorNetwork;
      if (isPointBoxCorner(d.corner) && e.shiftKey) {
        let delta = (Math.atan2(p.y - (d.bounds.y + d.bounds.h / 2), p.x - (d.bounds.x + d.bounds.w / 2)) - (d.startAngle ?? 0)) * 180 / Math.PI;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        d.rotationDeg = Math.round(delta / 15) * 15;
        d.currentX = p.x;
        d.currentY = p.y;
        network = rotatePointNetwork(root, d.id, d.origNetwork, d.networkIndices, d.bounds, d.rotationDeg);
      } else {
        d.rotationDeg = undefined;
        network = resizePointNetwork(root, d.id, d.origNetwork, d.networkIndices, d.bounds, d.corner,
          p.x - d.wx, p.y - d.wy, e.shiftKey && !isPointBoxCorner(d.corner), e.altKey);
      }
      engine.dispatch({ type: "patchVectorNetwork", id: d.id, preserveBounds: true, network });
    } else if (d.mode === "widthPt") {
      // Run 23 — the pull maps onto each selected point's stroke normal:
      // across the line thickens, along it slides. Positions never move.
      const wpt = toWorld(e.clientX, e.clientY);
      const wRoot = snap.pages[snap.page].root;
      const wn = d.id ? worldPos(wRoot, d.id) : null;
      if (wn && d.wOrig && d.wSel && widthEditOk(wn.node) && allowTopologyEdit(engine, d.id!)) {
        const dx = wpt.x - d.wx;
        const dy = wpt.y - d.wy;
        const half = Math.max(1, (wn.node.strokeWidth || 1) / 2);
        const next = d.wOrig.map((q) => ({ ...q }));
        for (const i of d.wSel) {
          const st = widthStationAt(wn.node.path, wn.node.closed, next[i].position);
          if (!st) continue;
          const dm = (-st.ty * dx + st.tx * dy) / half;
          next[i].widthMultiplier = Math.min(MAX_WIDTH_MULTIPLIER, Math.max(0, next[i].widthMultiplier + dm));
        }
        engine.dispatch({ type: "patch", id: d.id, patch: { strokeWidthProfile: next } });
      }
    } else if (d.mode === "vecCut") {
      const wpt = toWorld(e.clientX, e.clientY);
      setCutLine({ x1: d.wx, y1: d.wy, x2: wpt.x, y2: wpt.y });
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
        // Figma's three point styles. `mirrorMode` is only written when someone
        // states it, so a point pulled out with the pen — mirrored handles, no
        // mode on record — has to be read as mirrored too; that is what
        // `effectiveMirrorMode` decides from the handles themselves.
        const mode = effectiveMirrorMode(p);
        if (d.handle === "in") {
          p.ix = lx - p.x;
          p.iy = ly - p.y;
          if (e.altKey) {
            // ⌥ breaks the point: the twin stays where it was, and the break is
            // *written down*, so releasing ⌥ and dragging again does not silently
            // re-mirror the handle the user just set free.
            p.mirrorMode = BREAK_MIRROR_MODE;
          } else if (mode === "angleAndLength") {
            p.ox = -p.ix;
            p.oy = -p.iy;
          } else if (mode === "angle" && (p.ox || p.oy)) {
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
          if (e.altKey) {
            p.mirrorMode = BREAK_MIRROR_MODE;
          } else if (mode === "angleAndLength") {
            p.ix = -p.ox;
            p.iy = -p.oy;
          } else if (mode === "angle" && (p.ix || p.iy)) {
            const outLen = Math.hypot(p.ox, p.oy);
            const inLen = Math.hypot(p.ix || 0, p.iy || 0);
            if (outLen > 0.001) {
              p.ix = (-p.ox / outLen) * inLen;
              p.iy = (-p.oy / outLen) * inLen;
            }
          }
        } else {
          const movingIndices = snap.vecPoints && snap.vecPoints.includes(d.point) ? snap.vecPoints : [d.point];
          const hasHandles =
            (p.ox || 0) !== 0 || (p.oy || 0) !== 0 || (p.ix || 0) !== 0 || (p.iy || 0) !== 0;
          if (e.altKey && movingIndices.length === 1 && !hasHandles) {
            // ⌥-drag a corner anchor pulls a Bézier handle out of it instead
            // of moving the point; a mirrored point (authored or, per
            // `effectiveMirrorMode`, one whose handles say mirrored) pulls both
            // sides out together, which is how the gesture works in Figma.
            p.ox = lx - p.x;
            p.oy = ly - p.y;
            if (mode === "angleAndLength") {
              p.ix = -p.ox;
              p.iy = -p.oy;
            }
          } else {
            // ⇧ constrains the move to the dominant axis (Figma).
            let tlx = lx;
            let tly = ly;
            if (e.shiftKey && d.origPts && d.origPts[d.point]) {
              const o = d.origPts[d.point];
              if (Math.abs(lx - o.x) >= Math.abs(ly - o.y)) tly = o.y;
              else tlx = o.x;
            }
            if (movingIndices.length > 1 && d.origPts) {
              const origP = d.origPts[d.point];
              const totalDx = tlx - origP.x;
              const totalDy = tly - origP.y;
              for (const idx of movingIndices) {
                if (d.origPts[idx] && pts[idx]) {
                  pts[idx].x = d.origPts[idx].x + totalDx;
                  pts[idx].y = d.origPts[idx].y + totalDy;
                }
              }
            } else {
              p.x = tlx;
              p.y = tly;
            }
          }
        }
        engine.dispatch({ type: "patchPath", id: n.id, path: pts, closed: effClosed(n) });
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
      const rootNow = snap.pages[snap.page].root;
      // Inside a flipped ancestor the screen turns the other way from the
      // layer's own angle.
      let deltaDeg = (((curAngle - (d.startAngle ?? 0)) * 180) / Math.PI) * parentHandedness(rootNow, d.id);
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
      // The pivot slide is measured on the page; the layer stores its offset
      // in its parent's axes.
      const slide = worldDeltaToParent(rootNow, d.id, next.x - d.orig.x, next.y - d.orig.y);
      engine.dispatch({
        type: "patch",
        id: d.id,
        patch: {
          x: (d.origLocal?.x ?? wp.node.x) + slide.dx,
          y: (d.origLocal?.y ?? wp.node.y) + slide.dy,
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
    } else if (d.mode === "pathStart" && d.id) {
      // Text-on-path start handle: sliding it moves where the text begins
      // along the path (360039956434).
      const root = snap.pages[snap.page].root;
      const n = find(root, d.id);
      const geom = n ? onPathGeometry(root, n) : null;
      const tw = n ? worldPos(root, d.id) : null;
      if (n && geom && tw) {
        const wpt = toWorld(e.clientX, e.clientY);
        const { at } = walkNearest(geom.walk, wpt.x - tw.x - geom.dx, wpt.y - tw.y - geom.dy);
        engine.dispatch({
          type: "patch",
          id: d.id,
          patch: { pathStart: geom.walk.len > 0 ? at / geom.walk.len : 0 },
        });
      }
    } else if (d.mode === "autoPad" && d.id && d.padEdge && d.origPad) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp?.node.layout) {
        const [pl, pr, pt, pb] = d.origPad;
        // Padding is measured along the frame's own edges: the drag is taken in
        // the layer's local axes (own rotation and any rotated/flipped
        // ancestor), not the page's.
        const ld = localDragDelta(wp, d.wx, d.wy, wpt.x, wpt.y);
        const dx = Math.round(ld.dx);
        const dy = Math.round(ld.dy);
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
    } else if (d.mode === "smartGap" && d.axis && d.smartGap != null && d.smartSX != null) {
      const wpt = toWorld(e.clientX, e.clientY);
      // "Click and drag the handle to adjust the space between layers. A
      // tooltip above your cursor shows the current space between layers, in
      // pixels." Right/down grows the space, left/up shrinks it; ⇧ steps by
      // the Big nudge setting, the same convention the auto-layout gap handle
      // uses. The value is applied to every gap in the run at once, which is
      // what makes the selection "adjust … uniformly".
      const big = e.shiftKey && !e.altKey ? getNudgePrefs().big : 1;
      const raw = d.axis === "x" ? wpt.x - d.smartSX : wpt.y - d.smartSX;
      const nextGap = Math.max(0, Math.round((d.smartGap + raw) / big) * big);
      engine.dispatch({
        type: "distributeSpacing",
        ids: [...snap.selection],
        axis: d.axis === "x" ? "h" : "v",
        gap: nextGap,
      });
    } else if (d.mode === "autoGap" && d.id && d.origGap != null) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp?.node.layout) {
        const l = wp.node.layout;
        const horiz = l.direction === "horizontal";
        const axis: "gap" | "gapCross" = d.gapAxis === "gapCross" ? "gapCross" : "gap";
        // ⇧ drags the gap in big-nudge steps, as it does for padding.
        const big = e.shiftKey && !e.altKey ? getNudgePrefs().big : 1;
        const ld = localDragDelta(wp, d.wx, d.wy, wpt.x, wpt.y);
        // A wrapped flow's line spacing moves ACROSS the flow direction.
        const delta = Math.round(axis === "gap" ? (horiz ? ld.dx : ld.dy) : (horiz ? ld.dy : ld.dx));
        const nextGap = Math.max(0, Math.round((d.origGap + delta) / big) * big);
        // Dragging an Auto spacing IS setting it: convert to a fixed number,
        // or the layout pass would recompute `autoSpacing` from the free
        // space and the drag would paint nothing (help 31289464393751 shows
        // the pill carrying the computed value precisely so it can be
        // grabbed into a number).
        const nextLayout = {
          ...l,
          [axis]: nextGap,
          ...(axis === "gap" && l.gapMode === "auto" ? { gapMode: "fixed" as const } : {}),
        };
        engine.dispatch({ type: "autoLayout", id: d.id, layout: nextLayout });
      }
    } else if (d.mode === "starRatio" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const lp = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const maxR = Math.hypot(wp.node.w / 2, wp.node.h / 2);
        const curR = Math.hypot(lp.x - wp.node.w / 2, lp.y - wp.node.h / 2);
        const ratio = Math.max(0.05, Math.min(0.95, curR / (maxR || 1)));
        engine.dispatch({ type: "patch", id: d.id, patch: { starRatio: ratio } });
      }
    } else if ((d.mode === "starRadius" || d.mode === "polyRadius") && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        // Distance down from the shape's own top edge, in its local axes.
        const lp = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const dist = Math.max(0, lp.y);
        const maxR = Math.min(wp.node.w, wp.node.h) * 0.4;
        const newR = Math.max(0, Math.min(maxR, Math.round(dist)));
        engine.dispatch({ type: "patch", id: d.id, patch: { cornerRadii: [newR, newR, newR, newR] } });
      }
    } else if ((d.mode === "starCount" || d.mode === "polyCount") && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const lp = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const angle = Math.atan2(lp.y - wp.node.h / 2, lp.x - wp.node.w / 2) + Math.PI / 2;
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
        // The pin slides along the corner's own diagonal, so the inset is
        // measured in the layer's local axes (rotated / flipped ancestry too).
        const lp = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const dx = left ? lp.x : wp.node.w - lp.x;
        const dy = top ? lp.y : wp.node.h - lp.y;
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
        // Arc angles live in the ellipse's own frame: a rotated ellipse (or one
        // inside a rotated frame) reads the pointer in local coordinates.
        const lp = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const cx = wp.node.w / 2;
        const cy = wp.node.h / 2;
        const curArc = wp.node.arcData ?? { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 };
        const angleAt = () => {
          let ang = Math.atan2(lp.y - cy, lp.x - cx);
          if (ang < 0) ang += Math.PI * 2;
          if (e.shiftKey) ang = Math.round((ang * 180) / Math.PI / 15) * (Math.PI / 12);
          return ang;
        };
        if (d.handle === "start") {
          // The Start handle drags the arc's beginning around the circle
          // ("you can drag this around the circle to change the position of
          // the ring"); ⇧ snaps to 15 degrees like the sweep does.
          engine.dispatch({
            type: "patch",
            id: d.id,
            patch: { arcData: { ...curArc, startingAngle: angleAt() } },
          });
        } else if (d.handle === "in") {
          const maxR = Math.min(wp.node.w, wp.node.h) / 2;
          const curR = Math.hypot(lp.x - cx, lp.y - cy);
          const ratio = Math.max(0, Math.min(0.95, curR / (maxR || 1)));
          engine.dispatch({
            type: "patch",
            id: d.id,
            patch: { arcData: { ...curArc, innerRadius: Math.round(ratio * 100) / 100 } },
          });
        } else {
          let ang = angleAt();
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
    pointerClient.current = { x: e.clientX, y: e.clientY };
    dragIx.current = null;
    // §23 PT-004: release completes the press pair on the release-position node.
    if (snap.presentFrame) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      const n = hitTest(root, wpt.x, wpt.y, { includeLocked: true });
      if (n) runTrigger(root, n.id, "mouseUp");
      return;
    }
    if (penDrag.current) {
      penDrag.current = null;
      return;
    }
    if (pencil.current) {
      const pts = pencil.current;
      pencil.current = null;
      if (pts.length >= 2) {
        const tol = PENCIL_TOLERANCE_PX / snap.zoom;
        const thinned = simplifyPath(pts, tol);
        const smoothed = snap.tool === "pencil" ? smoothPath(thinned, false) : thinned;
        commitPathWasm(smoothed, false);
      }
      setDraft([]);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setBand(null);
    setGuides([]);
    setGapBadges([]);
    // Run 23 — a clean click on the stroke (armed at press, pink preview
    // showing) adds a width point where the pointer landed. Anything that
    // moved drops it: the layer still drags from the line as before.
    if (pendingWidth.current) {
      const p = pendingWidth.current;
      pendingWidth.current = null;
      const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
      const pLoc = worldPos(snap.pages[snap.page].root, p.id);
      if (
        moved < 4 &&
        snap.selection[0] === p.id &&
        pLoc &&
        widthEditOk(pLoc.node) &&
        allowTopologyEdit(engine, p.id)
      ) {
        const prof = normalizeWidthProfile(pLoc.node.strokeWidthProfile);
        const add = { position: p.t, widthMultiplier: sampleVariableWidth(prof, p.t) };
        const next = normalizeWidthProfile([...prof, add]);
        engine.dispatch({ type: "begin" });
        engine.dispatch({ type: "patch", id: p.id, patch: { strokeWidthProfile: next } });
        engine.dispatch({ type: "end" });
        const ai = next.findIndex((q) => Math.abs(q.position - p.t) < 1e-9);
        setWidthSel([ai >= 0 ? ai : next.length - 1]);
        // With a move group still open the begin nests into it and the
        // gesture's own `end` settles add+move as ONE undo entry.
      }
    }
    if (!d) return;
    if (d.mode === "vecLasso") {
      setLassoPath([]);
      const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 4;
      if (!moved || !d.id) return;
      const root = snap.pages[snap.page].root;
      const node = find(root, d.id);
      if (!node) return;
      const boundary = [...(d.lassoPoints ?? [])];
      const end = toWorld(e.clientX, e.clientY);
      const last = boundary[boundary.length - 1];
      if (!last || Math.hypot(end.x - last.x, end.y - last.y) * snap.zoom >= 1) boundary.push(end);
      const path = node.path.length ? node.path : shapePoly(node);
      const previous = snap.vecPoints?.length ? snap.vecPoints : snap.vecPoint != null ? [snap.vecPoint] : [];
      const selected = lassoSelectPathPoints(
        path, effClosed(node), boundary,
        (x, y) => localToWorld(root, node.id, x, y),
        previous, d.lassoOperation ?? "replace",
      );
      vecPt.current = selected.length ? selected[0] : -1;
      setVecEdit(node.id, selected[0] ?? null, selected);
      return;
    }
    if (d.mode === "vecCut") {
      setCutLine(null);
      const cutRoot = snap.pages[snap.page].root;
      const loc = d.id ? worldPos(cutRoot, d.id) : null;
      if (!d.id || !loc || !allowTopologyEdit(engine, d.id)) return;
      const n = loc.node;
      const pts = n.path.length ? n.path : shapePoly(n);
      if (pts.length < 2) return;
      const closed = effClosed(n);
      const ls = nodeLocalPoint(d.wx, d.wy, loc.x, loc.y, n);
      const we = toWorld(e.clientX, e.clientY);
      const le = nodeLocalPoint(we.x, we.y, loc.x, loc.y, n);
      const isDrag = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 4;
      let runs: PathPoint[][] | null = null;
      if (!isDrag) {
        // Click: split at the pressed vertex, else insert an anchor on the
        // pressed segment and split there — one point, two paths.
        let vi = -1;
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(ls.x - pts[i].x, ls.y - pts[i].y) < 8 / snap.zoom) {
            vi = i;
            break;
          }
        }
        if (vi >= 0) {
          runs = splitPathAtPoint(pts, closed, vi);
        } else {
          const res = insertPointOnPath(pts, ls.x, ls.y, closed, 10 / snap.zoom);
          if (res) runs = splitPathAtPoint(res.newPath, closed, res.insertedIndex);
        }
      } else {
        // Drag: the blade line severs every segment it crosses; the runs
        // after the first each become their own vector object.
        runs = cutPathWithLine(pts, closed, ls.x, ls.y, le.x, le.y);
      }
      if (!runs) {
        toast("Nothing to cut");
        return;
      }
      // One begin/end pair: the patches and the layers the cut spawns land as
      // a single undo step.
      engine.dispatch({ type: "begin" });
      engine.dispatch({ type: "patchPath", id: n.id, path: runs[0], closed: false });
      for (const extra of runs.slice(1)) {
        engine.dispatch({
          type: "addPath",
          points: extra.map((p) => ({ ...p, x: p.x + loc.x, y: p.y + loc.y })),
          closed: false,
        });
      }
      // addPath re-selects the piece it just made; the edit session belongs
      // to the original node, and a selection without the edited id would
      // silently leave point edit — so selection returns to it.
      engine.dispatch({ type: "select", ids: [n.id] });
      engine.dispatch({ type: "end" });
      return;
    }
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
      d.mode === "vecResize" ||
      d.mode === "grad" ||
      d.mode === "gradStop" ||
      d.mode === "gradMid" ||
      d.mode === "multiResize" ||
      d.mode === "multiRotate" ||
      d.mode === "rotOrigin" ||
      d.mode === "autoPad" ||
      d.mode === "pathStart" ||
      d.mode === "autoGap" ||
      d.mode === "smartGap" ||
      d.mode === "arc" ||
      d.mode === "widthPt" ||
      d.mode === "crop" ||
      d.mode === "cropMove" ||
      d.mode === "cropRotate" ||
      d.mode === "cropScale" ||
      (d.mode === "marquee" && d.id === "erase")
    )
      engine.dispatch({ type: "end" });
    // Phase 10: Finalize eraser via WASM when a stroke path was collected.
    // The TS erase already ran during the drag for visual feedback; the WASM
    // call here produces the mathematically correct geometry splitting as
    // ONE atomic undo step (replacing the multiple TS dispatches).
    if (d.mode === "marquee" && d.id === "erase" && eraserPath.current) {
      const ep = eraserPath.current;
      eraserPath.current = null;
      if (ep.targetId && ep.points.length >= 2) {
        const ERASER_RADIUS = ERASER_PX / snap.zoom;
        const xyPoints = ep.points.map(([x, y]) => ({ x, y }));
        void (async () => {
          try {
            const { wasmEraseGeometry } = await import("../engine/wasmDrawing");
            const root = engine.snapshot().pages[engine.snapshot().page].root;
            await wasmEraseGeometry(root, ep.targetId!, xyPoints, ERASER_RADIUS);
          } catch {
            // WASM path unavailable — TS erase already applied during drag
          }
        })();
      }
    }
    if ((d.mode === "crop" || d.mode === "cropMove" || d.mode === "cropRotate" || d.mode === "cropScale") && d.id) {
      const fresh = engine.snapshot();
      const cn = find(fresh.pages[fresh.page].root, d.id);
      const dims = cn && cropImageDims(cn);
      if (cn && dims) {
        cropZoomBase.current = cn.imageCrop ? { ...cn.imageCrop } : coverCrop(dims.iw, dims.ih, cn.w, cn.h);
        setCropZoom(100);
      }
    }
    if (d.mode === "move") {
      if (dropHint) setDropHint(null);
      const fresh = engine.snapshot();
      const selection = fresh.selection;
      const root = fresh.pages[fresh.page].root;
      // The drop target is the frame under the cursor, read off a fresh tree -
      // the mid-drag snapshot is a frame behind and the selection has moved.
      const pt = toWorld(e.clientX, e.clientY);
      const frame = dropTargetFrame(root, pt.x, pt.y, new Set(selection));
      const frameWorld = frame ? worldPos(root, frame.id) : null;
      if (frame && frameWorld) {
        // Figma's drop modifiers (360039959014 §Bypass default behavior):
        //   - Space while dragging prevents auto-reparenting entirely
        //     ("hold the Space bar to keep an object within the current
        //     parent" / "prevent Figma from reparenting").
        //   - ⌘/Ctrl bypasses the oversize refusal.
        //   - Ctrl on Mac drops the object as absolutely positioned.
        const isMac = /mac/i.test(navigator.platform ?? "");
        const spaceBypass = space.current;
        const absolute = e.ctrlKey && isMac;
        const bypass = e.metaKey || (e.ctrlKey && !isMac);
        // Space held → refuse any cross-parent reparent for this drag; the
        // object stays with its current parent (same-parent reorders are
        // still allowed, because those don't change the parent).
        const lx = pt.x - frameWorld.x;
        const ly = pt.y - frameWorld.y;
        const linear = !!frame.layout && frame.layout.direction !== "grid";
        const sameParent: string[] = [];
        const incomers: string[] = [];
        for (const id of selection) {
          const item = worldPos(root, id);
          const parent = findParent(root, id);
          if (!item || item.node.id === frame.id || !parent || find(item.node, frame.id)) continue;
          // Size gate (360039959014 §Parenting behavior): "If an object is
          // smaller than a frame, we will make it a child … If larger,
          // then we will not." Applies to freeform frames too, not just
          // auto layout. A hug axis always fits because the frame grows
          // around the newcomer; ⌘/Ctrl or absolute drops override it.
          const tooBig =
            !bypass &&
            !absolute &&
            item.node.w > frame.w + 0.5 &&
            item.node.h > frame.h + 0.5;
          if (spaceBypass && parent !== frame) continue;
          if (tooBig) continue;
          if (absolute) {
            // Out of the flow, where the move put it; cross-parent drops
            // reparent below instead.
            if (parent === frame) engine.dispatch({ type: "patch", id, patch: { absolutePosition: true } });
            else incomers.push(id);
          } else if (parent === frame) sameParent.push(id);
          else incomers.push(id);
        }
        // Dragging within the frame reorders to the gap under the cursor;
        // without a layout there is no order to change.
        if (sameParent.length && linear) {
          engine.dispatch({
            type: "reorder",
            ids: sameParent,
            parent: frame.id,
            index: flowInsertIndex(frame, lx, ly),
          });
        }
        // Newcomers land as a block at the gap under the cursor. Grids place
        // each object in its own cell instead, and plain frames append.
        if (incomers.length) {
          const r2 = engine.snapshot().pages[engine.snapshot().page].root;
          const dest = find(r2, frame.id);
          const fw2 = worldPos(r2, frame.id);
          if (dest && fw2) {
            const base = linear ? flowInsertIndex(dest, lx, ly) : 0;
            incomers.forEach((id, i) => {
              const item = worldPos(r2, id);
              if (!item) return;
              engine.dispatch({
                type: "reparent",
                ids: [id],
                parent: frame.id,
                x: item.x - fw2.x,
                y: item.y - fw2.y,
                ...(linear ? { index: base + i } : {}),
                ...(absolute ? { absolute: true } : {}),
                ...(bypass ? { bypassSizeGate: true } : {}),
              });
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
        } else {
          // Figma parity: non-text shape/frame/line/arrow/slice/section tools
          // do NOT stamp a default-size shape on a bare click — you must drag.
          // A click either selects the topmost layer under the cursor or
          // (nothing hit) deselects. We fall back to select mode, clear the
          // drag, and perform the same hit-test/select a plain click would
          // have done in Move. Without this, an accidental click in
          // rect/ellipse/frame/line mode dropped a 100×100 shape on canvas.
          drag.current = null;
          engine.dispatch({ type: "setTool", tool: "select" });
          const root2 = snap.pages[snap.page].root;
          const wpt2 = toWorld(e.clientX, e.clientY);
          const hit = hitTest(root2, wpt2.x, wpt2.y, { deep: false });
          if (e.shiftKey) {
            const cur = new Set(snap.selection);
            if (hit) {
              if (cur.has(hit.id)) cur.delete(hit.id);
              else cur.add(hit.id);
            }
            engine.dispatch({ type: "select", ids: Array.from(cur) });
          } else {
            engine.dispatch({ type: "select", ids: hit ? [hit.id] : [] });
          }
          setBand(null);
          return;
        }
        x = a.x;
        y = a.y;
      } else if (k === "line" || k === "arrow") {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let ang = Math.atan2(dy, dx);
        if (shift) ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const rawLen = Math.max(1, Math.hypot(dx, dy));
        // Alt draws the line outward from the press point (draw from center),
        // mirroring the rect/ellipse behaviour in Figma's shape tools doc.
        // The line's own coordinate system is horizontal (rotation = ang),
        // with x in [0, len] and center at len/2, h/2.  We place the box so
        // that its geometric center (before rotation) sits at the press
        // point when Alt is held, and at the drag midpoint otherwise.
        const len = alt ? rawLen * 2 : rawLen;
        w = len;
        h = 1;
        const cx = alt ? a.x : a.x + Math.cos(ang) * (rawLen / 2);
        const cy = alt ? a.y : a.y + Math.sin(ang) * (rawLen / 2);
        x = cx - w / 2;
        y = cy - h / 2;
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
          let dx = lb.x - la.x;
          let dy = lb.y - la.y;
          // Shift snaps line angle to 45° increments, matching the canvas
          // branch above and Figma's Shape-tools article: hold Shift to draw
          // lines along 0/45/90/135°.
          let ang = Math.atan2(dy, dx);
          if (shift) ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          const rawLen = Math.max(1, Math.hypot(dx, dy));
          // With Alt the drag starts at the line midpoint, so double the
          // length (matches the non-frame alt branch for rect/ellipse).
          const len = alt ? rawLen * 2 : rawLen;
          // Re-project the endpoint along the (possibly snapped) angle so the
          // line actually lies on the constrained direction even after Alt.
          const ex = la.x + Math.cos(ang) * len;
          const ey = la.y + Math.sin(ang) * len;
          nodeW = len;
          nodeH = 1;
          // Without Alt the line is centered on drag start→end midpoint; with
          // Alt the line starts at the press point and extends out.
          if (alt) {
            nodeX = la.x - len / 2;
            nodeY = la.y - 0.5;
          } else {
            nodeX = (la.x + ex) / 2 - len / 2;
            nodeY = (la.y + ey) / 2 - 0.5;
          }
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
          ? // A real section: the node defaults give it the article's
            // background and border, and it never clips.
            { name: "Section" }
          : snap.tool === "slice"
            ? {
                name: "Slice",
                fill: "#00000000",
                fillVisible: false,
                strokePaint: DOC_SLICE_STROKE,
                strokeVisible: true,
                strokeWidth: 1,
                strokeDash: 4,
                isSlice: true,
              }
          : k === "text"
            ? clicked
              ? { text: "", sizingW: "hug", sizingH: "hug", fontSize: 16 }
              : // A dragged box is exact dimensions: Fixed size, like Figma.
                { text: "", sizingW: "fixed", sizingH: "fixed", fontSize: 16 }
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
      // Text on a path (360039956434 §Add text to a path): clicking the text
      // tool on a shape's outline attaches the new text to that path, and the
      // path's fill and effects transfer to the text.
      if (k === "text" && clicked) {
        const target = nearOutline(root, a.x, a.y, 8);
        const twalk = target ? outlineWalk(target) : null;
        const tpos = target ? worldPos(root, target.id) : null;
        if (target && twalk && tpos) {
          const { at } = walkNearest(twalk, a.x - tpos.x, a.y - tpos.y);
          engine.dispatch({
            type: "add",
            kind: "text",
            x: nodeX,
            y: nodeY,
            w: nodeW,
            h: nodeH,
            parent: host?.id,
            extra: {
              text: "",
              sizingW: "hug",
              sizingH: "hug",
              fontSize: 16,
              name: "Text on path",
              onPath: target.id,
              pathStart: twalk.len > 0 ? at / twalk.len : 0,
              pathSide: "left",
              fill: target.fill,
              fillOpacity: target.fillOpacity,
              fillVisible: target.fillVisible,
              fillType: target.fillType,
              ...(target.gradientStops?.length ? { gradientStops: target.gradientStops.map((g) => ({ ...g })) } : {}),
              ...(target.effects?.length ? { effects: target.effects.map((e) => ({ ...e })) } : {}),
            },
          });
          const id = engine.snapshot().selection[0];
          if (id) setEdit({ id, text: "" });
          if (snap.tool !== "slice") engine.dispatch({ type: "setTool", tool: "select" });
          return;
        }
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

      // F7: the band now collects at the drilled scope (children of the frame
      // you are inside), not always at page-root level; one shared function
      // with the click policy keeps press and marquee honest with each other.
      const ids = marqueeCollect(
        snap.pages[snap.page].root,
        snap.selection,
        { x0, y0, x1, y1 },
        e.metaKey || e.ctrlKey,
      );
      // ⇧-marquee adds to the pre-drag selection instead of replacing it;
      // plain marquee still replaces.
      engine.dispatch({
        type: "select",
        ids: e.shiftKey ? Array.from(new Set([...(d.sel0 ?? []), ...ids])) : ids,
      });
    }
  };

  /** Wheel gestures, on a listener registered by hand so it can be cancelled.
   *
   *  React attaches `wheel` passively at the root, so the `preventDefault()` a
   *  JSX `onWheel` prop calls is discarded: Ctrl/⌘+wheel — and every trackpad
   *  pinch, which arrives as one — zoomed the browser page *as well as* the
   *  canvas, the two fighting each other on every gesture. Only a non-passive
   *  native listener may keep the gesture for the canvas, which is what makes
   *  the anchored zoom below actually hold the point under the cursor.
   *
   *  No React state is captured: the handler reads the live snapshot from the
   *  engine, so it never zooms against a stale pan. */
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.cancelable) e.preventDefault();
      const s = engine.snapshot();
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/⌘ + wheel and trackpad pinch both zoom at the cursor: a pinch
        // stream tracks the fingers, a wheel notch is one fixed step, and line-
        // and page-mode wheels are converted to pixels first.
        const factor = wheelZoomFactor({ deltaY: e.deltaY, deltaMode: e.deltaMode, pinch: e.ctrlKey });
        const next = clampZoom(s.zoom * factor);
        const box = el.getBoundingClientRect();
        const cx = e.clientX - box.left;
        const cy = e.clientY - box.top;
        const wx = (cx - s.panX) / s.zoom;
        const wy = (cy - s.panY) / s.zoom;
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
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [engine]);

  const onDbl = (e: React.MouseEvent) => {
    if ((snap.tool === "pen" || snap.tool === "pencil") && draft.length >= 2) {
      // The double-click's own press lands on the intended last anchor; drop
      // it when it duplicates the previous point so finishing never leaves a
      // zero-length end segment.
      let commit = draft;
      if (commit.length >= 2) {
        const a = commit[commit.length - 1];
        const b = commit[commit.length - 2];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 1.5) commit = commit.slice(0, -1);
      }
      engine.dispatch({ type: "addPath", points: commit, closed: false });
      setDraft([]);
      setCloseHint(null);
      penBranch.current = null;
      return;
    }
    const wpt = toWorld(e.clientX, e.clientY);
    /* On-canvas ramp insert: a double-click ON the gradient axis adds a stop
     * there in the colour the ramp actually shows (the same OKLab mix the
     * inspector's bar uses). It outranks the edge-sizing double-click the way
     * the gradient press outranks resize handles in onDown. */
    if (snap.tool === "select" && snap.selection.length === 1) {
      const root0 = snap.pages[snap.page].root;
      const gid = snap.selection[0];
      const gp = worldPos(root0, gid);
      const gtl = gp && !isEffectivelyLocked(root0, gid) ? gradTarget(gp.node) : null;
      if (gp && gtl) {
        const z = snap.zoom;
        const nb = nodeVisualBounds(gp);
        const sx0 = snap.panX + nb.x * z;
        const sy0 = snap.panY + nb.y * z;
        const ax = sx0 + gtl.gx * nb.w * z;
        const ay = sy0 + gtl.gy * nb.h * z;
        const bx = sx0 + gtl.hx * nb.w * z;
        const by = sy0 + gtl.hy * nb.h * z;
        const px = wpt.x * z + snap.panX;
        const py = wpt.y * z + snap.panY;
        const vx = bx - ax;
        const vy = by - ay;
        const len2 = vx * vx + vy * vy;
        if (len2 > 4) {
          let t = ((px - ax) * vx + (py - ay) * vy) / len2;
          t = Math.max(0, Math.min(1, t));
          const dist = Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
          const pos = t;
          if (dist < 8 && pos > 0.001 && pos < 0.999 && !gtl.stops.some((s) => Math.abs(s.position - pos) < 0.012)) {
            const stops0 = gtl.stops;
            let after = stops0.findIndex((s) => s.position > pos);
            if (after < 0) after = stops0.length;
            const lo = stops0[Math.max(0, after - 1)];
            const hi = stops0[Math.min(after, stops0.length - 1)];
            const span = hi.position - lo.position;
            const fresh = { color: mixHex(lo.color, hi.color, span > 0 ? (pos - lo.position) / span : 0), position: pos };
            const sorted = [...stops0, fresh].sort((a, b) => a.position - b.position);
            const patch: Partial<XNode> = {
              gradientStops: sorted,
              fill: sorted[0].color,
              fillB: sorted[sorted.length - 1].color,
            };
            if (gtl.mids) {
              // Splitting the pair the new stop lands inside keeps both
              // halves even; pairs outside it — including a prepend or an
              // append — keep their authored midpoints.
              const mids0 = [...gtl.mids];
              if (after <= 0) mids0.unshift(0.5);
              else if (after >= stops0.length) mids0.push(0.5);
              else mids0.splice(after - 1, 1, 0.5, 0.5);
              patch.gradientMidpoints = mids0;
            }
            engine.dispatch({ type: "patch", id: gid, patch });
            return;
          }
        }
      }
    }
    /**
     * The path point the press is standing on, resolved off the *live* tree
     * (a childless boolean may have just been flattened into a fresh node), or
     * null when the layer cannot enter point edit from here. One test answers two
     * questions — which anchor a double-click selects on entry, and whether a press
     * on an anchor outranks the selection box's edge (for a vector the chrome draws
     * the box on the *path* bounds, so the two would otherwise fight) — at the same
     * radius the point-edit press grabs with.
     */
    const pathAnchorUnder = (id: string): number | null => {
      const live = engine.snapshot();
      const loc = worldPos(live.pages[live.page].root, id);
      if (!loc) return null;
      const n = loc.node;
      if (n.locked || n.children.length) return null;
      if (!PATH_ENTRY_KINDS.includes(n.kind)) return null;
      if (isInstanceMember(live.pages[live.page].root, n.id)) return null;
      const pts = n.path.length ? n.path : shapePoly(n);
      if (!pts.length) return null;
      const l = nodeLocalPoint(wpt.x, wpt.y, loc.x, loc.y, n);
      return anchorIndexAt(pts, l.x, l.y, VERTEX_PRIORITY_PX.edit / live.zoom);
    };
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
      // …but a press on the layer's own anchor is a path click, and the path wins.
      if (pathAnchorUnder(id) !== null) return null;
      const z = snap.zoom;
      // Measured on the box the chrome actually paints — `nodeVisualBounds`, which
      // follows a vector's path rather than its stale frame — and the pointer is
      // brought into that box's own axes first, exactly as the handle and rotation
      // hit tests do. Before, this read the raw translation-only placement, so on a
      // rotated layer (or a path that had been dragged outside its own bounds) a
      // double-click aimed at the path could be eaten as a hug/fill toggle.
      const nb = nodeVisualBounds(wp);
      const x0 = nb.x * z + snap.panX;
      const y0 = nb.y * z + snap.panY;
      const w = nb.w * z;
      const h = nb.h * z;
      let px = wpt.x * z + snap.panX;
      let py = wpt.y * z + snap.panY;
      {
        const cx = x0 + w / 2;
        const cy = y0 + h / 2;
        if (wp.node.rotation) {
          const u = unrot(px, py, cx, cy, wp.node.rotation);
          px = u.x;
          py = u.y;
        }
        if (wp.node.flipH) px = cx - (px - cx);
        if (wp.node.flipV) py = cy - (py - cy);
      }
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
        const walk = (n: XNode, parentIsFrame: boolean, selectedAncestor = false) => {
          if (!n.visible) return;
          const origin = localToWorld(root, n.id, 0, 0);
          const selected = snap.selection.includes(n.id);
          const nameW = Math.max(40, n.name.length * 6.5);
          if (n.kind === "section") {
            // The title sits inside the section's top-left (see labelNames).
            const sx = snap.panX + origin.x * z;
            const sy = snap.panY + origin.y * z;
            if (mx >= sx && mx <= sx + nameW + 8 && my >= sy + 2 && my <= sy + 20) {
              hitFrame = n;
            }
          } else if (n.kind === "frame" && n.showName !== false && (selected || (!parentIsFrame && !selectedAncestor))) {
            const sx = snap.panX + origin.x * z;
            const sy = snap.panY + origin.y * z;
            if (mx >= sx - 2 && mx <= sx + nameW + 10 && my >= sy - 18 && my <= sy - 2) {
              hitFrame = n;
            }
          }
          // Match labelNames: an invisible/culled label cannot start rename.
          for (const c of n.children) {
            walk(c, n.kind === "frame", selectedAncestor || selected);
          }
        };
        for (const ch of root.children) walk(ch, false);
        frameLabelHit = hitFrame;
      }
    }
    if (frameLabelHit) {
      const frame = frameLabelHit as XNode;
      const origin = localToWorld(snap.pages[snap.page].root, frame.id, 0, 0);
      const sx = snap.panX + origin.x * snap.zoom;
      const sy = snap.panY + origin.y * snap.zoom;
      // A section's title sits inside its top-left corner; a frame's label
      // hangs above the frame, so the editor follows the label it replaces.
      const onSection = frame.kind === "section";
      setFrameEdit({ id: frame.id, name: frame.name, x: sx, y: onSection ? sy - 1 : sy - 22 });
      engine.dispatch({ type: "select", ids: [frame.id] });
      return;
    }
    const root = snap.pages[snap.page].root;
    const hit = canvasClickTarget(root, wpt.x, wpt.y, snap.selection);
    // Resolve the selected container BEFORE text/crop/vector entry. A deep
    // hit here used to edit the leaf immediately and bypass one-level drilling.
    if (hit && (hit.kind === "frame" || hit.kind === "group" || hit.kind === "boolean" || hit.kind === "component" || hit.kind === "instance") && hit.children.length) {
      const child = drillChild(root, hit, wpt.x, wpt.y);
      if (child) engine.dispatch({ type: "select", ids: [child.id] });
      return;
    }
    if (hit?.kind === "text") setEdit({ id: hit.id, text: hit.text });
    else if (vecEdit && hit && hit.id === vecEdit && hit.path.length) {
      const loc = worldPos(snap.pages[snap.page].root, hit.id);
      if (loc) {
        const path = hit.path.map((pt) => ({ ...pt }));
        // Same vertex test the point loop uses, from the shared helper: the
        // double-click converts the point it is on and leaves it selected, so
        // the handles that just appeared are already grabbed.
        const best = anchorIndexAt(path.map((pt) => ({ x: loc.x + pt.x, y: loc.y + pt.y })), wpt.x, wpt.y, VERTEX_PRIORITY_PX.edit / snap.zoom) ?? -1;
        if (best >= 0) {
          const pt = path[best];
          const has = (pt.ox && pt.ox !== 0) || (pt.oy && pt.oy !== 0);
          if (has) {
            pt.ix = 0;
            pt.iy = 0;
            pt.ox = 0;
            pt.oy = 0;
          } else {
            const h = smoothHandlesForPoint(path, best, !!hit.closed);
            pt.ix = h.ix;
            pt.iy = h.iy;
            pt.ox = h.ox;
            pt.oy = h.oy;
          }
          engine.dispatch({ type: "patchPath", id: hit.id, path, closed: hit.closed });
          setVecEdit(hit.id, best, [best]);
        }
      }
    } else if (snap.tool === "select" && hit && hit.fillType === "image") {
      enterCrop(hit.id);
      return;
    } else if (
      hit &&
      PATH_ENTRY_KINDS.includes(hit.kind) &&
      (hit.kind !== "boolean" || !hit.children.length)
    ) {
      if (isInstanceMember(snap.pages[snap.page].root, hit.id)) {
        toast("Edit the main component to change this layer");
        return;
      }
      engine.dispatch({ type: "select", ids: [hit.id] });
      // Basic shapes edit in place (first edit converts kind); only a
      // childless boolean bakes down. Booleans with children drill above.
      const id = hit.kind === "boolean" ? (engine.dispatch({ type: "flatten" }), engine.snapshot().selection[0]) : hit.id;
      if (id) {
        // Figma's deep-click opens the path with the vertex you aimed at already
        // selected, so the press that follows drags the point instead of starting
        // a rubber band. An edge click (or a press on the fill) enters with
        // nothing selected, which is what a segment grab wants.
        const pt = pathAnchorUnder(id);
        setVecEdit(id, pt, pt != null ? [pt] : []);
      }
    } else if (hit) {
      engine.dispatch({ type: "select", ids: [hit.id] });
    } else if (vecEdit) {
      setVecEdit(null, null, []);
    }
  };

  const onLeave = (e: React.MouseEvent) => {
    onUp(e);
    hoverIx.current = "";
    cursorPosRef.current = null;
    setCursorPos(null);
    // Nothing is hovered once the pointer is gone, and a stale "+" would keep
    // advertising an insert the next click cannot make.
    if (addPt) setAddPt(null);
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
    let dx = -minX - (opts?.centre ? spanW / 2 : 0);
    let dy = -minY - (opts?.centre ? spanH / 2 : 0);
    // A drop anchors the artwork's top-left at the cursor and parents it to
    // whatever frame sits under it. Dropped on that frame's edge - which is
    // what happens whenever the cursor is over the border itself - the artwork
    // lands almost entirely outside the frame's clip and only a sliver shows,
    // so the drop looks like it did nothing. An axis whose visible overlap is
    // under a pixel is therefore pulled inside, flush to the far edge when the
    // artwork fits, else flush to the host's origin so at least part shows.
    if (host && host.overflow !== "visible") {
      const left = origin.x + dx + minX;
      const top = origin.y + dy + minY;
      const fit = (v: number, span: number, size: number) =>
        span <= size ? Math.min(Math.max(v, 0), size - span) : 0;
      const shownX = Math.min(left + spanW, host.w) - Math.max(left, 0);
      const shownY = Math.min(top + spanH, host.h) - Math.max(top, 0);
      if (shownX < 1) dx += fit(left, spanW, host.w) - left;
      if (shownY < 1) dy += fit(top, spanH, host.h) - top;
    }
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

  const placeFiles = (files: FileList | File[], at?: { x: number; y: number }, grid?: boolean) => {
    const all = Array.from(files);
    for (const f of all) {
      if (f.type === "image/svg+xml" || /\.svg$/i.test(f.name)) placeSvg(f, at);
      else if (/\.sketch$/i.test(f.name)) placeSketch(f, at);
      else if (/\.fig$/i.test(f.name)) placeFig(f, at);
    }
    const list = all.filter(
      (f) => f.type.startsWith("image/") && f.type !== "image/svg+xml" && !/\.svg$/i.test(f.name),
    );
    if (!list.length) return;
    // Sizes first, then one layout pass under a single undo: a drop lands in
    // aligned rows of ten, a paste cascades from its target.
    const jobs = list.map(
      (file) =>
        new Promise<{ src: string; name: string; w: number; h: number }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const src = String(reader.result);
            const im = new Image();
            im.onload = () => resolve({ src, name: file.name.replace(/\.[^.]+$/, ""), w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = reject;
            im.src = src;
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        }),
    );
    Promise.allSettled(jobs).then((rs) => {
      const items = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!items.length) return;
      // Written to the asset store now, not at the next save: the document
      // will only ever hold a reference to it.
      for (const it of items) rememberImage(it.src);
      engine.dispatch({ type: "begin" });
      try {
        const origin = at ?? { x: 80, y: 80 };
        let cx = origin.x;
        let cy = origin.y;
        let rowH = 0;
        items.forEach((it, k) => {
          const sc = Math.min(1, 480 / Math.max(it.w, it.h));
          const pw = Math.max(8, it.w * sc);
          const ph = Math.max(8, it.h * sc);
          if (grid && k % 10 === 0 && k > 0) {
            cx = origin.x;
            cy += rowH + 24;
            rowH = 0;
          }
          const current = engine.snapshot();
          const root = current.pages[current.page].root;
          const host = deepestFrame(root, cx, cy);
          const local = host ? worldToLocal(root, host.id, cx, cy) : { x: cx, y: cy };
          engine.dispatch({
            type: "add",
            kind: "rect",
            x: local.x,
            y: local.y,
            w: pw,
            h: ph,
            parent: host?.id,
            extra: {
              imageSrc: it.src,
              fillType: "image",
              imageFit: "fill",
              name: it.name,
              fill: "#00000000",
              fillVisible: true,
            },
          });
          if (grid) {
            cx += pw + 24;
            rowH = Math.max(rowH, ph);
          } else {
            cx += 24;
            cy += 24;
          }
        });
      } finally {
        engine.dispatch({ type: "end" });
      }
    });
  };

  /** One image at a point: a click on a shape fills the shape, anywhere else
   *  adds a layer at (capped) natural size. */
  const placeSingleImage = (img: { src: string; name: string }, wpt: { x: number; y: number }) => {
    const current = engine.snapshot();
    const root = current.pages[current.page].root;
    const hit = hitTest(root, wpt.x, wpt.y, { deep: true });
    if (hit && hit.kind !== "text" && hit.kind !== "line" && hit.kind !== "arrow" && !hit.locked) {
      engine.dispatch({ type: "select", ids: [hit.id] });
      engine.dispatch({
        type: "patch",
        id: hit.id,
        patch: {
          fillType: "image",
          imageSrc: img.src,
          imageFit: "fill",
          imageTile: 100,
          imageCrop: undefined,
          fill: "#00000000",
          fillVisible: true,
          name: hit.nameLocked ? hit.name : img.name,
        },
      });
      return;
    }
    const el = new Image();
    el.onload = () => {
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      const sc = Math.min(1, 480 / Math.max(w, h));
      const now = engine.snapshot();
      const r2 = now.pages[now.page].root;
      const host = deepestFrame(r2, wpt.x, wpt.y);
      const local = host ? worldToLocal(r2, host.id, wpt.x, wpt.y) : wpt;
      engine.dispatch({
        type: "add",
        kind: "rect",
        x: local.x,
        y: local.y,
        w: Math.max(8, w * sc),
        h: Math.max(8, h * sc),
        parent: host?.id,
        extra: {
          imageSrc: img.src,
          fillType: "image",
          imageFit: "fill",
          name: img.name,
          fill: "#00000000",
          fillVisible: true,
        },
      });
    };
    el.src = img.src;
  };

  /** Files from the picker become a placement queue: one click per image. */
  const queueImages = (files: FileList | File[], at?: { x: number; y: number }) => {
    const list = Array.from(files).filter(
      (f) => f.type.startsWith("image/") && f.type !== "image/svg+xml" && !/\.svg$/i.test(f.name),
    );
    if (!list.length) return;
    const jobs = list.map(
      (file) =>
        new Promise<{ src: string; name: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ src: String(reader.result), name: file.name.replace(/\.[^.]+$/, "") });
          reader.onerror = reject;
          reader.readAsDataURL(file);
        }),
    );
    Promise.allSettled(jobs).then((rs) => {
      const srcs = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!srcs.length) return;
      for (const q of srcs) rememberImage(q.src);
      // The image tool already took a click: the first lands there, the rest
      // queue behind it.
      if (at) {
        placeSingleImage(srcs[0], at);
        if (srcs.length === 1) {
          engine.dispatch({ type: "setTool", tool: "select" });
          return;
        }
        setPlacing({ srcs: srcs.slice(1), i: 0 });
        toast(`Placing ${srcs.length - 1} more — click to place, Esc to stop`);
      } else {
        setPlacing({ srcs, i: 0 });
        toast(
          srcs.length === 1
            ? "Click to place the image · Esc to stop"
            : `Placing ${srcs.length} images — click to place, Esc to stop`,
        );
      }
    });
  };

  const placeQueued = (wpt: { x: number; y: number }) => {
    if (!placing) return;
    const cur = placing.srcs[placing.i];
    if (!cur) {
      setPlacing(null);
      return;
    }
    placeSingleImage(cur, wpt);
    if (placing.i + 1 >= placing.srcs.length) {
      setPlacing(null);
      engine.dispatch({ type: "setTool", tool: "select" });
    } else {
      setPlacing({ srcs: placing.srcs, i: placing.i + 1 });
    }
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
    over = false,
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
        // A paste at an explicit point is the menu's Paste here, whose
        // top-left sits on the point; a ⌘V with no point centres the copy on
        // the viewport. ⇧ rides `inPlace` for the text/link ladder and `over`
        // for the node one — Figma's Paste over selection.
        engine.dispatch({
          type: "paste",
          x: target.x,
          y: target.y,
          inPlace,
          over,
          anchor: at ? "topLeft" : "center",
        });
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
    void placeClipboard(parseClipboard(e.clipboardData), undefined, inPlace, inPlace).then((handled) => {
      // Nothing readable on the system clipboard: the copy made inside this
      // document still pastes, which is what ⌘V did before this existed.
      if (!handled) engine.dispatch({ type: "paste", inPlace, over: inPlace });
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
      const d = (e as CustomEvent<{ x?: number; y?: number; inPlace?: boolean; over?: boolean }>).detail ?? {};
      const at = d.x != null && d.y != null ? { x: d.x, y: d.y } : undefined;
      void readSystemClipboard().then((src) =>
        placeClipboard(parseClipboard(src), at, !!d.inPlace, !!d.over).then((handled) => {
          if (!handled)
            engine.dispatch({
              type: "paste",
              x: d.x,
              y: d.y,
              inPlace: d.inPlace,
              over: d.over,
              anchor: at ? "topLeft" : "center",
            });
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
    snap.tool === "hand" || spaceHeld
      ? "grab"
      : snap.tool === "zoom"
        ? zoomOutCursor
          ? "zoom-out"
          : "zoom-in"
      : snap.tool === "scale"
        ? "nwse-resize"
        : // Figma's "+" outranks every tool cursor on the canvas: the pointer is
          // over a path it can add an anchor to, and that is the one thing the
          // next click will do.
          addPt
          ? ADD_POINT_CURSOR
        : CREATE.includes(snap.tool) ||
            snap.tool === "pen" ||
            snap.tool === "pencil" ||
            snap.tool === "brush" ||
            snap.tool === "slice" ||
            snap.tool === "eraser"
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
    const node = wp.node;
    const measure = ref.current?.getContext("2d");
    // The same leading the painter uses, floor included: a live editor whose
    // rows advance differently would drift a little more with every line.
    const lh = Math.max(1, effectiveLineHeight(node) * snap.zoom);
    let textW = node.w;
    let textH = node.h;
    if (measure && (node.sizingW === "hug" || node.sizingH === "hug")) {
      const m = textMetrics(measure, { ...node, text: edit.text, textRuns: spansAfterTextEdit(node, edit.text) }, edit.text);
      // `hugHeight` is what the commit applies (`hugSize`), so the box does not
      // resize on blur either.
      textW = Math.max(node.w, Math.ceil(m.maxW + 4));
      textH = Math.max(node.h, hugHeight(m.lines, m.gaps, effectiveLineHeight(node), node.paragraphSpacing || 0, m.extra ?? 0));
    }
    const gutter = listGutter(measure ?? null, node);
    const boxW = textW * snap.zoom;
    const boxH = textH * snap.zoom;
    // A textarea hangs its first row off the CSS line box; the painter hangs it
    // off the canvas "top" baseline, `firstRowInset` below the layer's top. The
    // two anchors are genuinely different (Blink's "top" is the em box, not the
    // line box's ascent), so the live text used to jump on entry and back on
    // commit. Offset the text inside the frame by the measured difference; the
    // frame itself stays on the layer's box.
    let contentTop = 0;
    if (measure) {
      const ratios = fontMetricRatios(measure, node);
      if (ratios) {
        let inset = 0;
        if (valignApplies(node) || node.verticalTrim) {
          const m = textMetrics(measure, { ...node, text: edit.text, textRuns: spansAfterTextEdit(node, edit.text) }, edit.text);
          const blockH = m.lines * lh + (m.gaps * (node.paragraphSpacing || 0) + m.extra) * snap.zoom;
          inset = firstRowInset(node, boxH, blockH, node.fontSize, snap.zoom);
        }
        contentTop = overlayRowShift(ratios, node.fontSize * snap.zoom, lh, inset);
      }
    }
    const boxLeft = snap.panX + wp.x * snap.zoom;
    const boxTop = snap.panY + wp.y * snap.zoom;
    return {
      // Canvas-wrap coordinates for the popups that hang off the editor.
      left: boxLeft,
      top: boxTop,
      frame: {
        left: boxLeft,
        top: boxTop,
        width: boxW,
        height: boxH,
        // The frame turns as one piece: the row correction rides inside it, so a
        // rotated layer keeps its text on the same painted baseline.
        transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
        transformOrigin: "center center",
      } as CSSProperties,
      text: {
        // The text box tracks the corrected row: the layer's box plus the
        // shifted band, so no row is clipped and the wrap width is untouched.
        // A downward correction rides on padding, which keeps the textarea
        // covering the frame for clicks; an upward one moves the box itself.
        top: Math.min(0, contentTop),
        ...(contentTop > 0 ? { paddingTop: contentTop } : {}),
        height: boxH + Math.abs(contentTop),
        left: 0,
        right: 0,
        fontSize: node.fontSize * snap.zoom,
        fontWeight: node.fontWeight,
        lineHeight: `${lh}px`,
        letterSpacing: `${node.letterSpacing * snap.zoom}px`,
        textAlign: node.textAlign === "justified" ? "left" : node.textAlign,
        color: node.fill,
        // Font fallback (360040449673): unsupported characters render in Noto.
        fontFamily: fontFamilyStack(node.fontFamily),
        // Numbers (360039956634 §Numbers): the browser applies the same font
        // features to the live editor that SVG export and Dev Mode emit.
        fontVariantNumeric: [
          node.slashedZero ? "slashed-zero" : "",
          node.fractions ? "diagonal-fractions" : "",
          node.figureStyle === "proportional-oldstyle" ? "oldstyle-nums proportional-nums"
            : node.figureStyle === "monospace-lining" ? "lining-nums tabular-nums"
            : node.figureStyle === "monospace-oldstyle" ? "oldstyle-nums tabular-nums"
            : node.figureStyle === "proportional-lining" ? "lining-nums proportional-nums" : "",
        ].filter(Boolean).join(" ") || undefined,
        // OpenType features & variable axes (4913951097367 / 5579502031511):
        // the live editor uses the same font settings the exports emit.
        fontFeatureSettings: node.fontFeatures && Object.keys(node.fontFeatures).length
          ? Object.entries(node.fontFeatures).map(([k, v]) => `"${k}" ${v}`).join(", ")
          : undefined,
        fontVariationSettings: node.fontVariations && Object.keys(node.fontVariations).length
          ? Object.entries(node.fontVariations).map(([k, v]) => `"${k}" ${v}`).join(", ")
          : undefined,
        // The overlay is a real textarea, so the wrap style is handed to the
        // browser's own text-wrap - the standard editor rule.
        ...((node.textWrap === "balance" || node.textWrap === "pretty") ? { textWrap: node.textWrap } : {}),
        ...(indentOf(node) ? { textIndent: `${indentOf(node) * snap.zoom}px` } : {}),
        ...(gutter ? { paddingLeft: Math.round(gutter * snap.zoom) } : {}),
      } as CSSProperties,
    };
  })();

  const docRoot = snap.pages[snap.page].root;
  // An empty page, not presenting, and not mid-stroke: the moment a layer exists
  // the card has nothing left to teach and goes away by itself.
  const showFirstRun =
    firstRun && docRoot.children.length === 0 && !snap.presentFrame && !draft.length;
  return (
    <div
      className="canvas-wrap"
      ref={wrap}
      style={{ cursor }}
      onClick={(e) => {
        // Links (360045942953 §Interact with links): clicking linked text
        // follows the link; "hold ⌘/Ctrl while clicking" just selects.
        if (e.metaKey || e.ctrlKey || e.shiftKey || snap.presentFrame || edit || snap.tool !== "select") return;
        const wpt = toWorld(e.clientX, e.clientY);
        const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { deep: true });
        const url = hit && hit.kind === "text" ? hit.link : undefined;
        if (url) {
          e.preventDefault();
          window.open(url, "_blank", "noopener");
        }
      }}
      onMouseMove={(e) => {
        onMove(e);
        // Hover previews the URL (§Interact: "hover over the linked text").
        const wpt = toWorld(e.clientX, e.clientY);
        const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { deep: true });
        const url = hit && hit.kind === "text" ? hit.link : undefined;
        const r = wrap.current?.getBoundingClientRect();
        if (url) {
          setLinkHover({ left: e.clientX - (r?.left ?? 0) + 12, top: e.clientY - (r?.top ?? 0) + 18, url });
        } else if (linkHover) setLinkHover(null);
      }}
      onMouseDown={onDown}
      onMouseUp={onUp}
      onMouseLeave={onLeave}
      onDoubleClick={onDbl}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const wpt = toWorld(e.clientX, e.clientY);
        if (e.dataTransfer.files?.length) placeFiles(e.dataTransfer.files, wpt, true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const wpt = toWorld(e.clientX, e.clientY);
        /* Right-click on a visible stop dot deletes that stop (the ramp keeps
         * at least two). The menu does not open — the click WAS the action. */
        if (snap.tool === "select" && snap.selection.length === 1) {
          const root0 = snap.pages[snap.page].root;
          const gid = snap.selection[0];
          const gp = worldPos(root0, gid);
          const gtl = gp && !isEffectivelyLocked(root0, gid) ? gradTarget(gp.node) : null;
          if (gp && gtl && gtl.stops.length > 2) {
            const z = snap.zoom;
            const nb = nodeVisualBounds(gp);
            const sx0 = snap.panX + nb.x * z;
            const sy0 = snap.panY + nb.y * z;
            const ax = sx0 + gtl.gx * nb.w * z;
            const ay = sy0 + gtl.gy * nb.h * z;
            const bx = sx0 + gtl.hx * nb.w * z;
            const by = sy0 + gtl.hy * nb.h * z;
            const px = wpt.x * z + snap.panX;
            const py = wpt.y * z + snap.panY;
            let victim = -1;
            for (let i = 0; i < gtl.stops.length; i++) {
              const s = gtl.stops[i];
              if (s.position <= 0.001 || s.position >= 0.999) continue;
              const x = ax + (bx - ax) * s.position;
              const y = ay + (by - ay) * s.position;
              if (Math.hypot(px - x, py - y) < 9) {
                victim = i;
                break;
              }
            }
            if (victim >= 0) {
              const sorted = gtl.stops.filter((_, k) => k !== victim);
              const patch: Partial<XNode> = {
                gradientStops: sorted,
                fill: sorted[0].color,
                fillB: sorted[sorted.length - 1].color,
              };
              if (gtl.mids) patch.gradientMidpoints = gtl.mids.filter((_, k) => k !== victim);
              engine.dispatch({ type: "patch", id: gid, patch });
              return;
            }
          }
        }
        const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y);
        if (hit && !snap.selection.includes(hit.id)) {
          engine.dispatch({ type: "select", ids: [hit.id] });
        }
        if (!hit) engine.dispatch({ type: "select", ids: [] });
        setMenu({ x: e.clientX, y: e.clientY, wx: wpt.x, wy: wpt.y });
      }}
    >
      <canvas key={snap.colorProfile} ref={ref} role="img" aria-label="Design canvas" />
      {cropId && (() => {
        const cropNode = find(snap.pages[snap.page].root, cropId);
        if (!cropNode) return null;
        const rotation = ((((cropNode.imageRot ?? 0) + 180) % 360) + 360) % 360 - 180;
        return (
          <div
            className="crop-toolbar"
            role="toolbar"
            aria-label="Image crop controls"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <label className="crop-control">
              <span>Aspect</span>
              <select aria-label="Crop aspect ratio" value={cropAspect} onChange={(e) => setCropAspect(e.target.value as typeof cropAspect)}>
                <option value="image">Original</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="16:9">16:9</option>
                <option value="3:2">3:2</option>
                <option value="free">Free</option>
              </select>
            </label>
            <label className="crop-control crop-range">
              <span>Zoom {cropZoom}%</span>
              <input
                aria-label="Crop zoom"
                type="range"
                min={100}
                max={400}
                step={5}
                value={cropZoom}
                onChange={(e) => setCropZoomValue(parseInt(e.target.value, 10))}
              />
            </label>
            <button
              type="button"
              className="crop-action"
              onClick={resetCrop}
            >
              Resize to fit
            </button>
            <label className="crop-control crop-range">
              <span>Rotate {Math.round(rotation)}°</span>
              <input
                aria-label="Crop rotation"
                type="range"
                min={-180}
                max={180}
                step={1}
                value={rotation}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10);
                  cropDirty.current = true;
                  cropZoomBase.current = undefined;
                  setCropZoom(100);
                  engine.dispatch({ type: "patch", id: cropId, patch: { imageRot: value } });
                }}
              />
            </label>
            <button type="button" className="crop-action" onClick={cancelCrop}>Cancel</button>
            <button type="button" className="crop-action primary" onClick={applyCrop}>Done</button>
          </div>
        );
      })()}
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
          root={snap.pages[snap.page].root}
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
          chrome={chromePref}
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
          chrome={chromePref}
        />
      )}
      {showFirstRun && (
        /* LP-U4: the coldest screen in the product is an empty canvas — the dock,
           the panels and the inspector are all there and not one of them says
           what to do first. One card, until the page has a layer or the visitor
           dismisses it. It must not eat the drag it is describing, so the sheet
           gives the card `pointer-events: none` and only its button gets them
           back — the `.cm-layer` / `.cm-pin` recipe the comment pins already use. */
        <div className="canvas-hint">
          <p className="canvas-hint-title">Draw your first layer</p>
          <p className="canvas-hint-body">
            Press <kbd>F</kbd> and drag on the canvas for a frame, <kbd>R</kbd> for a
            rectangle, <kbd>T</kbd> for text. Whatever you draw lands in the Layers list,
            where you can name it, group it and hand it to the inspector.
          </p>
          <XButton
            variant="ghost"
            size="sm"
            icon="close"
            className="canvas-hint-x"
            onClick={() => {
              dismissEmptyCanvasHint();
              setFirstRun(false);
            }}
          >
            Don&rsquo;t show this again
          </XButton>
        </div>
      )}
      {transition && <div className={`proto-transition ${transition}`} aria-hidden="true" />}
      {edit && editBox && (
        // The frame is the layer's box (and its focus ring); the textarea inside
        // carries the row correction that keeps the glyphs on the painted
        // baseline. See `editBox` for the two anchors.
        <div className="text-edit-frame" style={editBox.frame}>
        <textarea
          className="text-edit"
          ref={editRef}
          style={editBox.text}
          value={edit.text}
          autoFocus
          // RTL (4972283635863): "Figma automatically handles text direction
          // based on language detection" unless the layer overrides it.
          dir={(() => {
            const t = worldPos(snap.pages[snap.page].root, edit.id)?.node;
            return t && (t.textDirection === "ltr" || t.textDirection === "rtl") ? t.textDirection : "auto";
          })()}
          onSelect={(e) => {
            // A select event may fire again with a collapsed range during blur.
            if (e.currentTarget.selectionStart < e.currentTarget.selectionEnd)
              captureRange(e.currentTarget, edit.id);
          }}
          onKeyUp={(e) => captureRange(e.currentTarget, edit.id)}
          onMouseUp={(e) => captureRange(e.currentTarget, edit.id)}
          onPaste={(e) => {
            // Links (360045942953 §Use paste in place): a pasted URL becomes a
            // linked range; ⇧ paste (and the ⌘⇧V chord's plain variant) keeps
            // it as text. "Paste the shortcut twice - once to paste it as
            // text, and once more to turn it into a link" falls out of this.
            const t = e.clipboardData?.getData("text/plain") ?? "";
            if (!/^https?:\/\/\S+$/i.test(t.trim()) || (e.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart ?? 0;
            const en = el.selectionEnd ?? s;
            setEdit({ ...edit, text: edit.text.slice(0, s) + t + edit.text.slice(en) });
            linkMarkRef.current = { start: s, end: s + t.length, url: t.trim() };
            setTimeout(() => el.setSelectionRange(s + t.length, s + t.length), 0);
          }}
          onChange={(e) => {
            rememberTextRange(engine, null);
            capturedRange.current = null;
            const raw = e.target.value;
            let next = raw;
            let caret = e.target.selectionStart ?? raw.length;
            // Smart quotes/symbols (360039957174): "->" becomes "→" and
            // friends, straight quotes curl - behind the Preferences toggle.
            if (smartSymbolsEnabled()) {
              next = smartConvert(raw);
              if (next !== raw) caret = smartConvert(raw.slice(0, caret)).length;
            }
            setEdit({ ...edit, text: next });
            // Emoji `:codes` (360039957174): typing ":name" opens the picker.
            const q = emojiQueryAt(next, caret);
            setEmojiPick(
              q
                ? {
                    // The picker hangs under the frame, not under the textarea's
                    // shifted text box: those two tops differ by the row shift.
                    left: editBox.left,
                    top: editBox.top + 26,
                    start: q.start,
                    query: q.query,
                  }
                : null,
            );
            if (next !== raw) setTimeout(() => e.target.setSelectionRange(caret, caret), 0);
          }}
          onBlur={(e) => {
            // Some browsers collapse the DOM selection as focus moves to the
            // inspector. Retain the last non-collapsed onSelect/mouseUp range.
            if (e.currentTarget.selectionStart < e.currentTarget.selectionEnd)
              captureRange(e.currentTarget, edit.id);
            else if (capturedRange.current?.id === edit.id)
              rememberTextRange(engine, capturedRange.current);
            const n = worldPos(snap.pages[snap.page].root, edit.id)?.node;
            const patch: Partial<XNode> = { text: edit.text };
            let runs = n && edit.text !== n.text ? spansAfterTextEdit(n, edit.text) : undefined;
            // A URL pasted in place (360045942953) lands as a linked run,
            // underlined by default like Figma's links.
            const lm = linkMarkRef.current;
            if (n && lm) {
              const base = { ...n, text: edit.text, textRuns: runs ?? n.textRuns ?? [] } as XNode;
              runs = styleTextRange(base, lm.start, lm.end, {
                link: lm.url,
                ...(base.textDecoration === "none" ? { textDecoration: "underline" as const } : {}),
              });
            }
            linkMarkRef.current = null;
            if (runs) patch.textRuns = runs;
            if (n && (n.sizingW === "hug" || n.sizingH === "hug"))
              Object.assign(patch, hugSize({ ...n, ...patch } as XNode, edit.text));
            engine.dispatch({ type: "patch", id: edit.id, patch });
            // Multi-edit: the same contents reach every selected text layer.
            for (const id of edit.also ?? []) {
              const ann = worldPos(snap.pages[snap.page].root, id)?.node;
              if (!ann) continue;
              const p2: Partial<XNode> = { text: edit.text };
              if (ann.sizingW === "hug" || ann.sizingH === "hug")
                Object.assign(p2, hugSize({ ...ann, ...p2 } as XNode, edit.text));
              engine.dispatch({ type: "patch", id, patch: p2 });
            }
            const sw = editSwitch.current;
            editSwitch.current = null;
            const nn = sw ? worldPos(snap.pages[snap.page].root, sw)?.node : null;
            if (nn && nn.kind === "text") {
              rememberTextRange(engine, null);
              capturedRange.current = null;
              setEdit({ id: sw as string, text: nn.text });
            } else setEdit(null);
          }}
          onKeyDown={(e) => {
            // Emoji `:code` picker (360039957174) owns the keys first: Tab or
            // Enter takes the top suggestion, Escape just closes the picker.
            if (emojiPick && (e.key === "Escape" || e.key === "Tab" || e.key === "Enter")) {
              e.preventDefault();
              if (e.key === "Escape") setEmojiPick(null);
              else {
                const sug = emojiCompletions(emojiPick.query, 1)[0];
                if (sug) emojiApply(sug.code, sug.emoji);
              }
              return;
            }
            if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter"))
              (e.target as HTMLTextAreaElement).blur();
            // ⇧⌘U (360045942953): the link input box above the selection.
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyU") {
              e.preventDefault();
              const el = e.target as HTMLTextAreaElement;
              const s = el.selectionStart ?? 0;
              const en = el.selectionEnd ?? s;
              window.dispatchEvent(new CustomEvent("x-native:link-input", {
                detail: {
                  // The frame's box, not the textarea's shifted text box.
                  left: editBox.left,
                  top: editBox.top - 40,
                  id: edit.id,
                  start: s,
                  end: en,
                },
              }));
              return;
            }
            // List editing (360040449773): the paragraph under the caret owns
            // its counter and its level; patches ride the normal undo stack.
            const el = e.target as HTMLTextAreaElement;
            const caret = el.selectionStart ?? 0;
            const textNow = edit.text;
            const paraIndex = (at: number) => textNow.slice(0, at).split("\n").length - 1;
            const patchParas = (patch: Partial<XNode>) =>
              engine.dispatch({ type: "patch", id: edit.id, patch });
            const nodeNow = worldPos(snap.pages[snap.page].root, edit.id)?.node;
            const pi = paraIndex(caret);
            // Creation characters: "- " or "* " bulleted, "1. " or "1) "
            // numbered (§Create a bulleted/numbered list) - the trigger text
            // is consumed and the paragraph takes the counter.
            if (e.key === " " && !e.metaKey && !e.ctrlKey && nodeNow) {
              const before = textNow.slice(0, caret);
              const paraStart = before.lastIndexOf("\n") + 1;
              const typed = before.slice(paraStart);
              const kind = typed === "-" || typed === "*" ? "bulleted"
                : typed === "1." || typed === "1)" ? "numbered" : null;
              if (kind) {
                e.preventDefault();
                const paraList = [...(nodeNow.paraList ?? [])];
                while (paraList.length < pi) paraList.push(undefined as never);
                paraList[pi] = kind;
                const upd = textNow.slice(0, paraStart) + textNow.slice(caret);
                setEdit({ ...edit, text: upd });
                setTimeout(() => {
                  el.setSelectionRange(paraStart, paraStart);
                  if (nodeNow.listStyle === "none") patchParas({ paraList, listStyle: kind });
                  else patchParas({ paraList });
                }, 0);
                return;
              }
            }
            // ⌘⇧8 / ⌘⇧7 convert the paragraphs under the caret into a list
            // (§Lists: "turn an individual text selection or multiple text
            // layers").
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "Digit8" || e.code === "Digit7")) {
              e.preventDefault();
              const kind: ListStyle = e.code === "Digit8" ? "bulleted" : "numbered";
              const from = paraIndex(el.selectionStart ?? 0);
              const to = paraIndex(el.selectionEnd ?? el.selectionStart ?? 0);
              const paraList = [...(nodeNow?.paraList ?? [])];
              for (let p = from; p <= to; p++) paraList[p] = kind;
              patchParas({ paraList, listStyle: kind });
              return;
            }
            // Tab, ⌘] or Ctrl+] increases the indent of the line (up to five
            // levels); ⌘[ / Ctrl+[ decreases it.
            if (
              (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) ||
              ((e.metaKey || e.ctrlKey) && (e.code === "BracketRight" || e.code === "BracketLeft"))
            ) {
              if (nodeNow && paraListStyle(nodeNow, pi) !== "none") {
                e.preventDefault();
                const down = e.code === "BracketLeft" || e.shiftKey;
                const listLevels = [...(nodeNow.listLevels ?? [])];
                while (listLevels.length < pi) listLevels.push(0);
                listLevels[pi] = Math.max(0, Math.min(4, listLevelOf(nodeNow, pi) + (down ? -1 : 1)));
                patchParas({ listLevels });
                return;
              }
            }
            // Backspace/Delete at the very start of a list item: "delete the
            // counter, but keep the same level of indentation".
            if ((e.key === "Backspace" || e.key === "Delete") && nodeNow) {
              const before = textNow.slice(0, caret);
              const atStart = e.key === "Backspace"
                ? before.length === 0 || before.endsWith("\n")
                : caret === textNow.length || textNow[caret] === "\n";
              if (atStart && paraListStyle(nodeNow, pi) !== "none") {
                e.preventDefault();
                const paraList = [...(nodeNow.paraList ?? [])];
                while (paraList.length < pi) paraList.push(undefined as never);
                paraList[pi] = null;
                patchParas({ paraList });
                return;
              }
            }
            // Return on an empty list item decreases its indentation (and an
            // empty level-0 item leaves the list).
            if (e.key === "Enter" && !e.shiftKey && nodeNow) {
              const before = textNow.slice(0, caret);
              const paraStart = before.lastIndexOf("\n") + 1;
              const after = textNow.slice(caret, textNow.indexOf("\n", caret) < 0 ? textNow.length : textNow.indexOf("\n", caret));
              const emptyItem = !before.slice(paraStart).trim() && !after.trim();
              if (emptyItem && paraListStyle(nodeNow, pi) !== "none") {
                e.preventDefault();
                const level = listLevelOf(nodeNow, pi);
                const paraList = [...(nodeNow.paraList ?? [])];
                while (paraList.length < pi) paraList.push(undefined as never);
                if (level > 0) {
                  const listLevels = [...(nodeNow.listLevels ?? [])];
                  while (listLevels.length < pi) listLevels.push(0);
                  listLevels[pi] = level - 1;
                  patchParas({ listLevels });
                } else {
                  paraList[pi] = null;
                  patchParas({ paraList });
                }
                return;
              }
            }
            e.stopPropagation();
          }}
        />
        </div>
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
              border: "1px solid var(--accent)",
              // Figma's inline rename field is a plain rectangle - the accent
              // hairline, square corners, no radius. This one used to be 4px,
              // which read as a chip rather than as a field in the document.
              borderRadius: 0,
              background: "var(--elevated)",
              color: "var(--text)",
              minWidth: 80,
              boxShadow: "var(--elev-floating)",
            }}
          />
        </div>
      )}
      {emojiPick && emojiCompletions(emojiPick.query).length > 0 && (
        // Emoji `:codes` (360039957174): type ":name" and take a suggestion.
        <div
          className="link-input"
          style={{ left: emojiPick.left, top: emojiPick.top, position: "absolute", zIndex: 31 }}
        >
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: "4px 6px",
              background: "var(--elevated)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "var(--elev-floating)",
            }}
          >
            {emojiCompletions(emojiPick.query).map(({ code, emoji }) => (
              <button
                key={code}
                className="icon-btn"
                title={`:${code}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  emojiApply(code, emoji);
                }}
                style={{ font: "16px Inter, system-ui" }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
      {linkInput && (
        /* Links (360045942953): "Type or paste a URL into the provided input
           box above the selected text. Press Enter to apply the link." */
        <div className="link-input" style={{ left: linkInput.left, top: linkInput.top, position: "absolute", zIndex: 30 }}>
          <input
            autoFocus
            placeholder="https://…"
            aria-label="Link URL"
            defaultValue={worldPos(snap.pages[snap.page].root, linkInput.id)?.node?.link ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setLinkInput(null);
                return;
              }
              if (e.key !== "Enter") return;
              const url = (e.target as HTMLInputElement).value.trim();
              const node = worldPos(snap.pages[snap.page].root, linkInput.id)?.node;
              if (node && linkInput.start != null && linkInput.end != null && linkInput.end > linkInput.start) {
                const runs = styleTextRange(node, linkInput.start, linkInput.end, {
                  ...(url ? { link: url } : {}),
                  ...(url && node.textDecoration === "none" ? { textDecoration: "underline" as const } : {}),
                });
                engine.dispatch({ type: "patch", id: linkInput.id, patch: { textRuns: runs } });
              } else if (node) {
                engine.dispatch({
                  type: "patch",
                  id: linkInput.id,
                  patch: {
                    ...(url ? { link: url } : {}),
                    // Links are underlined by default (360045942953 §Style
                    // links); ⌘U removes the underline.
                    ...(url && node.textDecoration === "none" ? { textDecoration: "underline" as const } : {}),
                  },
                });
              }
              setLinkInput(null);
            }}
            onBlur={() => setLinkInput(null)}
            style={{
              font: "12px Inter, system-ui",
              padding: "4px 8px",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              background: "var(--elevated)",
              color: "var(--text)",
              minWidth: 220,
              boxShadow: "var(--elev-floating)",
            }}
          />
        </div>
      )}
      {linkHover && (
        <div
          className="link-hover"
          style={{
            left: linkHover.left,
            top: linkHover.top,
            position: "absolute",
            zIndex: 25,
            pointerEvents: "none",
            font: "11px Inter, system-ui",
            padding: "3px 7px",
            borderRadius: 4,
            background: "var(--elev-floating)",
            color: "var(--text)",
            boxShadow: "var(--elev-floating)",
          }}
        >
          {linkHover.url} · click to open
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
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) {
            const at = pendingImage.current ?? undefined;
            queueImages(e.target.files, at);
            placeFiles(
              Array.from(e.target.files).filter((f) => !f.type.startsWith("image/") || f.type === "image/svg+xml" || /\.svg$/i.test(f.name)),
              at,
            );
          }
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
          className="canvas-dock conn-chip"
          onClick={(e) => e.stopPropagation()}
          style={{
            left: snap.panX + selectedConn.midX * snap.zoom,
            top: snap.panY + selectedConn.midY * snap.zoom,
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
            className="dock-x"
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
        <div className="canvas-dock vector-edit-toolbar">
          <button
            className={`tool-btn ${snap.tool === "select" && vecSubTool === "select" ? "on" : ""}`}
            onClick={() => {
              if (draft.length >= 2) {
                commitPathWasm(draft, false);
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
            className={`tool-btn ${vecSubTool === "lasso" ? "on" : ""}`}
            disabled={!vecEdit}
            onClick={() => {
              const next = vecSubTool === "lasso" ? "select" : "lasso";
              setVecSubTool(next);
              setLassoPath([]);
              if (next === "lasso") engine.dispatch({ type: "setTool", tool: "select" });
              toast(next === "lasso" ? "Lasso: drag around points or paths · Shift adds · Alt subtracts" : "Select mode");
            }}
            title="Lasso (Q) — drag to select vector points and paths"
            aria-label="Lasso tool"
          >
            <Icon name="lasso" size={14} />
            <span>Lasso</span>
          </button>
          <button
            className={`tool-btn ${snap.tool === "pen" ? "on" : ""}`}
            onClick={() => engine.dispatch({ type: "setTool", tool: "pen" })}
            title="Pen (P)"
          >
            <Icon name="pen" size={14} />
            <span>Pen</span>
          </button>
          <button
            className={`tool-btn ${vecSubTool === "bend" ? "on" : ""}`}
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
            className={`tool-btn ${vecSubTool === "cut" ? "on" : ""}`}
            onClick={() => {
              setVecSubTool((t) => (t === "cut" ? "select" : "cut"));
              toast(vecSubTool === "cut" ? "Select mode" : "Cut tool active: click a point or segment, or drag across the path");
            }}
            title="Cut tool (X)"
            aria-label="Cut tool"
          >
            <Icon name="scissors" size={14} />
            <span>Cut</span>
          </button>
          <button
            className="tool-btn"
            onClick={() => {
              if (vecEdit && allowTopologyEdit(engine, vecEdit)) {
                engine.dispatch({ type: "simplifyPath", id: vecEdit });
                toast("Simplified path");
              }
            }}
            disabled={!!vecEdit && topologyEditBlocked(find(snap.pages[snap.page].root, vecEdit))}
            title={vecEdit && topologyEditBlocked(find(snap.pages[snap.page].root, vecEdit)) ? NETWORK_EDIT_LIMIT : "Simplify path"}
          >
            <Icon name="scissors" size={14} />
          </button>
          <button
            className="tool-btn"
            onClick={() => {
              if (vecEdit && allowTopologyEdit(engine, vecEdit)) {
                engine.dispatch({ type: "vectorCleanup", id: vecEdit });
                toast("Cleaned up vector (sketch to perfect Bézier)");
              }
            }}
            disabled={!!vecEdit && topologyEditBlocked(find(snap.pages[snap.page].root, vecEdit))}
            title={vecEdit && topologyEditBlocked(find(snap.pages[snap.page].root, vecEdit)) ? NETWORK_EDIT_LIMIT : "Clean up vector (sketch to perfect Bézier)"}
          >
            <Icon name="visual-search" size={14} />
            Clean up
          </button>
          <button
            className="tool-btn"
            onClick={() => {
              if (draft.length > 0) {
                setDraft((d) => d.slice(0, -1));
                toast("Point deleted");
              } else if (vecPt.current != null && vecEdit) {
                const wp = worldPos(snap.pages[snap.page].root, vecEdit);
                if (wp && wp.node.path.length > 2 && allowTopologyEdit(engine, vecEdit)) {
                  const newPath = wp.node.path.filter((_, i) => i !== vecPt.current);
                  engine.dispatch({ type: "patchPath", id: vecEdit, path: newPath, closed: wp.node.closed });
                  setVecEdit(vecEdit, null, []);
                  toast("Point deleted");
                }
              }
            }}
            disabled={!!vecEdit && topologyEditBlocked(find(snap.pages[snap.page].root, vecEdit))}
            title={vecEdit && topologyEditBlocked(find(snap.pages[snap.page].root, vecEdit)) ? NETWORK_EDIT_LIMIT : "Delete point (⌫)"}
          >
            <Icon name="eraser" size={14} />
          </button>
          <div className="dock-sep" />
          <button
            className="dock-done"
            onClick={() => {
              if (draft.length >= 2) {
                commitPathWasm(draft, false);
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
            // §22 MN-004: grey out rows that would silently no-op — Detach on
            // non-instances, Reset with no overrides recorded, vectorize/outline
            // on layers they cannot touch.
            (() => {
              const root = snap.pages[snap.page].root;
              const nodes = snap.selection
                .map((id) => worldPos(root, id)?.node)
                .filter((n): n is NonNullable<typeof n> => !!n);
              const hasOverrides = (n: { overrides?: object }) =>
                !!n.overrides && Object.keys(n.overrides).length > 0;
              return {
                detach: nodes.some((n) => !!n.componentId && !n.isComponent),
                reset: nodes.some(hasOverrides),
                vectorize: nodes[0]?.kind === "text",
                outline: nodes.some(
                  (n) => n.kind === "text" || n.kind === "line" || n.kind === "arrow" || n.strokeWidth > 0,
                ),
                // "Remove mask" instead of "Use as mask" once the layer is one
                // (Figma's Masks article names that row for the right-click menu).
                mask: !!nodes[0]?.isMask,
              };
            })(),
          )}
          onRun={(id) => runMenu(engine, id, { x: menu.wx, y: menu.wy })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * A device-resolution raster tile for the effects composite.
 *
 * `box` is the layer's box in the painter's screen coordinates (the space
 * `traceNodeShape` takes), and `pad` grows the tile in those units so an effect
 * has room to reach outside the layer. The tile's transform mirrors the live
 * one, so the painter keeps drawing at absolute screen coordinates and lands
 * 1:1 in the tile; `blitTile` puts it back without resampling. Returns null when
 * the tile would be unreasonably large, which sends the caller down the direct
 * paint path instead.
 */
function effectsTile(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  pad: number,
): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; x: number; y: number; w: number; h: number } | null {
  const m = ctx.getTransform();
  const corners = [
    [bx, by],
    [bx + bw, by],
    [bx, by + bh],
    [bx + bw, by + bh],
  ].map(([ux, uy]) => [m.a * ux + m.c * uy + m.e, m.b * ux + m.d * uy + m.f]);
  // Device pixels per screen unit: the same matrix the paint is running under
  // (a zoomed-out layer keeps its device footprint, not its nominal one).
  const dev = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)) || 1;
  const grow = pad * dev;
  const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) - grow);
  const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) - grow);
  const x1 = Math.ceil(Math.max(...corners.map((c) => c[0])) + grow);
  const y1 = Math.ceil(Math.max(...corners.map((c) => c[1])) + grow);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 16777216) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const t = getCanvas2dContext(c);
  if (!t) return null;
  t.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
  return { c, ctx: t, x: x0, y: y0, w, h };
}

/**
 * Paint a tile back, 1:1 in device space, under the live clip, alpha and blend
 * mode. `filter` (a canvas filter string) applies to this blit alone, which is
 * how the layer blur reaches the finished composite instead of every draw op
 * inside it.
 */
function blitTile(
  ctx: CanvasRenderingContext2D,
  tile: { c: HTMLCanvasElement; x: number; y: number },
  filter = "none",
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = filter;
  ctx.drawImage(tile.c, tile.x, tile.y);
  ctx.restore();
}

function paintNoise(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  density: number,
  size = 1,
  color = "#ffffff",
) {
  const d = Math.max(0, Math.min(1, density / 100));
  if (d <= 0 || sw < 1 || sh < 1) return;
  const { r: cr, g: cg, b: cb, a: ca } = parseHex(color);
  if (ca <= 0) return;
  const s = Math.max(1, Math.round(size) || 1);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
  ctx.globalAlpha = 0.35 * d * ca;
  const count = Math.min(4000, Math.floor((sw * sh * d) / 18));
  const seed = Math.floor(sx * 13 + sy * 17);
  for (let i = 0; i < count; i++) {
    const h = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const r = h - Math.floor(h);
    const h2 = Math.sin(seed * 4.1414 + i * 19.19) * 23421.631;
    const r2 = h2 - Math.floor(h2);
    ctx.fillRect(sx + r * sw, sy + r2 * sh, s, s);
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

/** A pointer drag measured in a layer's local axes: both ends of the page-space
 *  drag go through the placement (own rotation/flip plus any rotated or flipped
 *  ancestor, since `wp` comes from `worldPlacement`), so "drag right" means
 *  "along the layer's +x" wherever the layer sits. */
/** One canvas gap control of a flow frame, in the node's LOCAL space: the
 *  rect the band paints plus the measured spacing it carries. */
type GapPill = { axis: "gap" | "gapCross"; gap0: number; x0: number; y0: number; x1: number; y1: number };

/** The gap pills of a flow frame — THE source for the painter, the hover
 *  cursor and the press hit-test, in the node's local space.
 *
 *  Spacing pills exist for every consecutive pair of flowed children (and,
 *  in a wrapping flow, for the space between the lines — that one drags
 *  `gapCross`); pairs that straddle a line break have no pill. A painted
 *  band that cannot be grabbed is the bug this table exists to prevent:
 *  paint, cursor and press all iterate it, so they cannot diverge again.
 *  Grid flows keep their inspector spacing — no canvas pills, no bands. */
function autoGapPills(node: XNode): GapPill[] {
  const l = node.layout;
  if (!l || l.direction === "grid") return [];
  const horiz = l.direction === "horizontal";
  const kids = node.children.filter((c) => c.visible && !c.absolutePosition);
  const wrapped = wraps(l);
  const pills: GapPill[] = [];
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1];
    const b = kids[i];
    if (wrapped && Math.abs((horiz ? a.y - b.y : a.x - b.x)) >= 0.5) continue;
    if (horiz) {
      const x = a.x + a.w;
      pills.push({
        axis: "gap",
        gap0: Math.max(0, Math.round(b.x - x)),
        x0: x,
        x1: Math.max(x, b.x),
        y0: (b.y || 0),
        y1: (b.y || 0) + b.h,
      });
    } else {
      const y = a.y + a.h;
      pills.push({
        axis: "gap",
        gap0: Math.max(0, Math.round(b.y - y)),
        x0: (b.x || 0),
        x1: (b.x || 0) + b.w,
        y0: y,
        y1: Math.max(y, b.y),
      });
    }
  }
  if (wrapped && kids.length >= 2) {
    const [pl, pr, pt, pb] = l.padding;
    const lines = flowWrapLines(kids, horiz);
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const cur = lines[i];
      if (horiz) {
        const y0 = Math.max(...prev.map((c) => c.y + c.h));
        const y1 = Math.min(...cur.map((c) => c.y));
        pills.push({ axis: "gapCross", gap0: Math.max(0, Math.round(y1 - y0)), x0: pl, x1: Math.max(pl, node.w - pr), y0, y1: Math.max(y0, y1) });
      } else {
        const x0 = Math.max(...prev.map((c) => c.x + c.w));
        const x1 = Math.min(...cur.map((c) => c.x));
        pills.push({ axis: "gapCross", gap0: Math.max(0, Math.round(x1 - x0)), x0, x1: Math.max(x0, x1), y0: pt, y1: Math.max(pt, node.h - pb) });
      }
    }
  }
  return pills;
}

/** Point-in-pill, in screen px: the painted band, padded to a minimum grab
 *  so a zero-gap flow still answers on the line between its children. */
function gapPillHit(pill: GapPill, sx: number, sy: number, z: number, px: number, py: number): boolean {
  const pad = 4;
  return (
    px >= sx + pill.x0 * z - pad &&
    px <= sx + pill.x1 * z + pad &&
    py >= sy + pill.y0 * z - pad &&
    py <= sy + pill.y1 * z + pad
  );
}

function localDragDelta(wp: { x: number; y: number; node: XNode }, fromX: number, fromY: number, toX: number, toY: number) {
  // Only the linear part: a hug frame grows (and its centre moves) while its
  // padding is dragged, so a point-based conversion would drift mid-drag.
  const v = unrot(toX - fromX, toY - fromY, 0, 0, wp.node.rotation || 0);
  return { dx: wp.node.flipH ? -v.x : v.x, dy: wp.node.flipV ? -v.y : v.y };
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

/**
 * Snap a gradient endpoint to the layer's own edges and centre. The threshold
 * stays in screen pixels, so it feels equally magnetic at 25% and 400% zoom.
 * Shift also constrains the axis between the dragged endpoint and the fixed
 * endpoint to 45° increments — moving either endpoint can therefore rotate a
 * linear, angular, radial, or diamond gradient precisely on canvas.
 */
function snappedGradientEndpoint(
  point: { x: number; y: number },
  fixed: { x: number; y: number },
  n: XNode,
  zoom: number,
  constrainAngle: boolean,
) {
  let x = point.x;
  let y = point.y;
  if (constrainAngle) {
    const dx = (x - fixed.x) * n.w;
    const dy = (y - fixed.y) * n.h;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x = fixed.x + (Math.cos(angle) * length) / Math.max(1, n.w);
      y = fixed.y + (Math.sin(angle) * length) / Math.max(1, n.h);
    }
  }
  const snap = (v: number, pxPerUnit: number) => {
    for (const target of [0, 0.5, 1]) if (Math.abs(v - target) * pxPerUnit <= SNAP_PX) return target;
    return v;
  };
  return {
    x: snap(x, Math.max(1, n.w * zoom)),
    y: snap(y, Math.max(1, n.h * zoom)),
  };
}

/** Position along a gradient's axis, in its normalised 0..1 ramp space. */
function gradientAxisPosition(
  point: { x: number; y: number },
  gradient: { gx: number; gy: number; hx: number; hy: number },
  n: XNode,
  zoom: number,
) {
  const vx = (gradient.hx - gradient.gx) * n.w;
  const vy = (gradient.hy - gradient.gy) * n.h;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-8) return 0;
  let position = ((point.x - gradient.gx) * n.w * vx + (point.y - gradient.gy) * n.h * vy) / len2;
  // The three canonical ramp positions are valuable precision targets when
  // placing a colour stop, exactly as the bounding-box centre is for geometry.
  const lenPx = Math.sqrt(len2) * zoom;
  for (const target of [0, 0.5, 1]) if (Math.abs(position - target) * lenPx <= SNAP_PX) position = target;
  return Math.max(0, Math.min(1, position));
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
  for (const id of transformSelectionRoots(root, ids)) {
    const n = find(root, id);
    if (!n) continue;
    const pb = (n.kind === "vector" || n.kind === "boolean") && n.path.length
      ? pathBounds(n.path, n.closed)
      : { minX: 0, minY: 0, w: n.w, h: n.h };
    const corners = [
      localToWorld(root, id, pb.minX, pb.minY),
      localToWorld(root, id, pb.minX + pb.w, pb.minY),
      localToWorld(root, id, pb.minX + pb.w, pb.minY + pb.h),
      localToWorld(root, id, pb.minX, pb.minY + pb.h),
    ];
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
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
/** Figma arms the pen with a "+" over a path it can add an anchor to. The web
 *  has no nib to attach one to, so the plus is the cursor: a white disc (so it
 *  reads on a dark fill), a black plus, hotspot at the centre — which is the
 *  exact point the click will insert, because the pointer centre *is* the probe. */
const ADD_POINT_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='7.5' fill='%23fff' fill-opacity='0.92' stroke='%23000' stroke-width='1.4'/%3E%3Cpath d='M12 8.2v7.6M8.2 12h7.6' stroke='%23000' stroke-width='1.9' stroke-linecap='round'/%3E%3C/svg%3E\") 12 12, crosshair";

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

/** Map an unflipped handle index to where it appears after the canvas' local
 * flip transform. Hit-testing unflips the pointer first, so cursor selection
 * must put that reflection back before applying the on-screen rotation. */
function visualHandleIndex(handle: number, flipH = false, flipV = false) {
  const horizontal = [2, 1, 0, 7, 6, 5, 4, 3];
  const vertical = [6, 5, 4, 3, 2, 1, 0, 7];
  let out = handle;
  if (flipH) out = horizontal[out] ?? out;
  if (flipV) out = vertical[out] ?? out;
  return out;
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
  append = false,
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
  if (!append) ctx.beginPath();
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
  append = false,
) {
  if (!append) ctx.beginPath();
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

/**
 * The rounded-rect outline a node paints, as a path. Smoothed corners are not
 * a roundRect: they go through the same polygon the hit test and the SVG export
 * use, so the three cannot drift apart. Module scope so the mask-outline
 * overlay can trace the same shape the layer paints.
 */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  z: number,
  append = false,
) {
  if (!append) ctx.beginPath();
  if (hasCornerSmoothing(n)) {
    tracePath(ctx, shapePoly(n), sx, sy, z, true, append);
    return;
  }
  const rr = roundRectRadii(n).map((r) => Math.max(0, r * z)) as [number, number, number, number];
  if (typeof ctx.roundRect === "function") ctx.roundRect(sx, sy, sw, sh, rr);
  else ctx.rect(sx, sy, sw, sh);
}

/**
 * One shape tracer for a node, in device space. The layer paint uses it for
 * every fill, stroke and effect pass, and the mask-outline overlay (View >
 * Mask outlines) uses it to stroke a mask: Figma's Masks article says "Once the
 * setting on, masks in your file are outlined in green", so the green line has
 * to follow exactly what the mask paints, whatever kind of layer it is.
 */
function traceNodeShape(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  z: number,
  append = false,
) {
  if (n.kind === "text") {
    if (!append) ctx.beginPath();
  } else if ((n.kind === "vector" || n.kind === "boolean") && (n.vectorNetwork || n.path.length)) {
    if (n.vectorNetwork && n.vectorNetwork.segments.length > 0) {
      traceVectorNetwork(ctx, n.vectorNetwork, sx, sy, z, append);
    } else {
      tracePath(ctx, n.path, sx, sy, z, n.closed, append);
    }
  } else if (n.kind === "ellipse") {
    if (!append) ctx.beginPath();
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
    if (!append) ctx.beginPath();
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
      append,
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
      append,
    );
  } else {
    roundRectPath(ctx, n, sx, sy, sw, sh, z, append);
  }
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  path: PathPoint[],
  ox: number,
  oy: number,
  z: number,
  closed: boolean,
  append = false,
) {
  if (!append) ctx.beginPath();
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
  append = false,
) {
  if (!append) ctx.beginPath();
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


/** Rich rows share the exact measured segments used by textMetrics. The
 * plain/uniform path above stays a single optimized fillText call. */
function paintStyledText(ctx: CanvasRenderingContext2D, n: XNode, sx: number, sy: number, sw: number, sh: number, z: number) {
  const rows = styledTextRows(ctx, n, n.text, sw, z);
  const lh = Math.max(1, effectiveLineHeight(n, Math.max(n.fontSize, ...resolvedTextSpans(n).map((r) => r.fontSize))) * z);
  const gap = (n.paragraphSpacing || 0) * z;
  const listGap = (n.listSpacing || 0) * z;
  const limit = n.truncate ? (valignApplies(n) || (n.maxH ?? 0) > 0
    ? fitLineCount(sh / Math.max(1e-6, z), effectiveLineHeight(n, n.fontSize), n.paragraphSpacing || 0)
    : n.maxLines > 0 ? n.maxLines : Infinity) : Infinity;
  const lines = truncateStyledRows(ctx, n, rows, limit, n.sizingW === "hug" ? Infinity : sw, z);
  const blockH =
    lines.reduce((h, r) => h + lh + (r.lastInPara ? gap + (r.itemGap ? listGap : 0) : 0), 0) -
    (lines.length && lines[lines.length - 1].lastInPara ? gap + (lines[lines.length - 1].itemGap ? listGap : 0) : 0);
  // Vertical alignment and the vertical-trim shift, exactly as paintText does -
  // one helper, so both painter paths agree with the editor overlay.
  let y = sy + firstRowInset(n, sh, blockH, n.fontSize, z);
  ctx.textBaseline = "top";
  ctx.save();
  if (n.truncate) {
    ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
  }
  const textFill = fillStyle(ctx, n, sx, sy, sw, sh);
  const strokeOn = n.strokeVisible && n.strokeWidth > 0 && (n.strokeType === "pattern" || !isNone(n.strokePaint));
  const strokeStyle = n.strokeType === "pattern"
    ? patternStrokeStyle(ctx, n, sx, sy, z) ?? "rgba(0,0,0,0)" : cssRgba(n.strokePaint);
  const ls = (n.letterSpacing || 0) * z;
  const draw = (mode: "fill" | "stroke" | "none", phase: "post" | "pre" = "post") => {
    let ty = y;
    for (const row of lines) {
      // RTL/bidi (4972283635863): per-paragraph direction - override, else
      // the row's own content decides.
      ctx.direction = directionOf(row.pieces.map((p) => p.text).join(""), n.paraDir?.[row.pi] ?? n.textDirection);
      const left = sx + row.lead;
      const inner = Math.max(0, sw - row.lead);
      let x = n.textAlign === "center" ? left + (inner - row.width) / 2
        : n.textAlign === "right" ? sx + sw - row.width : left;
      if (row.marker) {
        ctx.font = canvasTextFont(n, n.fontSize * z);
        ctx.textAlign = "left";
        ctx.fillStyle = textFill;
        if (mode === "fill") ctx.fillText(row.marker, sx + row.lead + row.markerX, ty);
        else if (mode === "stroke") ctx.strokeText(row.marker, sx + row.lead + row.markerX, ty);
      }
      // Justification stretches only inter-word gaps on non-final rows.
      const text = row.pieces.map((p) => p.text).join("");
      const spaces = n.textAlign === "justified" && !row.lastInPara ? [...text.matchAll(/ /g)].length : 0;
      const extra = spaces ? Math.max(0, inner - row.width) / spaces : 0;
      if (mode !== "none") {
        for (const [i, piece] of row.pieces.entries()) {
          // Faux super/subscript (§Numbers): shrunk glyphs repositioned when
          // the font offers no dedicated forms (or mixed with ones that do).
          const shift = piece.run.baselineShift ?? n.baselineShift;
          const faux = shift === "super" || shift === "sub";
          const psize = piece.run.fontSize * z;
          ctx.font = canvasTextFont(n, psize * (faux ? 0.7 : 1), piece.run);
          const pty = ty + (faux ? (shift === "super" ? -psize * 0.14 : psize * 0.38) : 0);
          ctx.textAlign = "left";
          ctx.fillStyle = piece.run.fill === n.fill ? textFill : cssRgba(piece.run.fill);
          if (ls || n.textAlign === "justified") {
            for (const ch of piece.text) {
              if (mode === "fill") ctx.fillText(ch, x, pty);
              else ctx.strokeText(ch, x, pty);
              x += measureCached(ctx, ch) + ls + (ch === " " ? extra : 0);
            }
          } else {
            if (mode === "fill") ctx.fillText(piece.text, x, pty);
            else ctx.strokeText(piece.text, x, pty);
            x += piece.width;
          }
          if (i < row.pieces.length - 1) x += ls;
        }
      } else {
        for (const [i, piece] of row.pieces.entries()) {
          x += piece.width + (i < row.pieces.length - 1 ? ls : 0);
        }
      }
      // Per-run decoration uses the same segment starts and widths as glyphs.
      let dx = n.textAlign === "center" ? left + (inner - row.width) / 2 : n.textAlign === "right" ? sx + sw - row.width : left;
      for (const piece of row.pieces) {
        const deco = piece.run.textDecoration ?? (n.textDecoration !== "none" ? n.textDecoration : "none");
        const skip = piece.run.underlineSkipInk ?? n.underlineSkipInk ?? false;
        const wantUnderline = deco === "underline" && (phase === "pre" ? skip : !skip);
        const wantStrike = deco === "strikethrough" && phase === "post";
        if (mode === "fill" && (wantUnderline || wantStrike)) {
          ctx.save(); ctx.shadowColor = "transparent";
          const psize = piece.run.fontSize * z;
          if (wantUnderline) {
            const yy = ty + psize + (piece.run.underlineOffset ?? n.underlineOffset ?? 0) * z;
            const uW = Math.max(0.5, (piece.run.underlineThickness ?? n.underlineThickness ?? 1) * z);
            const uStyle = piece.run.underlineStyle ?? n.underlineStyle ?? "solid";
            ctx.strokeStyle = cssRgba(piece.run.underlineColor ?? n.underlineColor ?? piece.run.fill);
            ctx.lineWidth = uW;
            if (uStyle === "dotted") ctx.setLineDash([uW, uW * 2]);
            ctx.beginPath();
            if (uStyle === "wavy") {
              const amp = Math.max(1, uW * 1.5);
              for (let wx = dx; wx < dx + piece.width; wx += amp * 2) {
                ctx.moveTo(wx, yy);
                ctx.quadraticCurveTo(wx + amp / 2, yy - amp, wx + amp, yy);
                ctx.quadraticCurveTo(wx + amp * 1.5, yy + amp, wx + amp * 2, yy);
              }
            } else {
              ctx.moveTo(dx, yy); ctx.lineTo(dx + piece.width, yy);
            }
            ctx.stroke(); ctx.setLineDash([]);
          }
          if (wantStrike) {
            ctx.strokeStyle = cssRgba(piece.run.fill);
            ctx.lineWidth = Math.max(1, z);
            const yy = ty + psize * 0.7;
            ctx.beginPath(); ctx.moveTo(dx, yy); ctx.lineTo(dx + piece.width, yy); ctx.stroke();
          }
          ctx.restore();
        }
        if (mode === "fill" && phase === "post" && (piece.run.slashedZero ?? n.slashedZero) && piece.text.includes("0")) {
          ctx.save(); ctx.shadowColor = "transparent";
          const psize = piece.run.fontSize * z;
          ctx.strokeStyle = piece.run.fill === n.fill ? textFill : cssRgba(piece.run.fill);
          ctx.lineWidth = Math.max(1, psize * 0.06);
          let acc = 0;
          for (const ch of piece.text) {
            const w = measureCached(ctx, ch) + ls;
            if (ch === "0") {
              const gW = w - ls;
              ctx.beginPath();
              ctx.moveTo(dx + acc + gW * 0.18, ty + psize * 0.8);
              ctx.lineTo(dx + acc + gW * 0.82, ty + psize * 0.1);
              ctx.stroke();
            }
            acc += w;
          }
          ctx.restore();
        }
        dx += piece.width + ls;
      }
      ty += lh + (row.lastInPara ? gap + (row.itemGap ? listGap : 0) : 0);
    }
  };
  if (n.fillVisible !== false && !isNone(n.fill)) {
    // Skip ink: the underline goes under the glyphs so their ink covers the
    // crossings (360039956634 §Decoration) - once, not per shadow pass.
    draw("none", "pre");
    const drops = (n.effects ?? []).filter((e) => e.kind === "drop-shadow" && e.visible);
    for (const drop of drops.length ? drops : [undefined]) {
      ctx.save();
      ctx.globalAlpha *= n.fillOpacity ?? 1;
      if (drop) {
        const { r, g, b, a } = parseHex(drop.color);
        ctx.shadowColor = `rgba(${r},${g},${b},${a})`;
        ctx.shadowBlur = Math.max(0, drop.blur) * z;
        ctx.shadowOffsetX = drop.x * z;
        ctx.shadowOffsetY = drop.y * z;
      } else {
        ctx.shadowColor = "transparent";
      }
      draw("fill");
      ctx.restore();
    }
  }
  if (strokeOn) {
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = strokeStyle;
    ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
    ctx.miterLimit = strokeCanvasMiterLimit(n.strokeMiterAngle);
    ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
    ctx.globalAlpha *= n.strokeOpacity ?? 1;
    draw("stroke");
    ctx.restore();
  }
  ctx.restore();
}

/** Text on a path (360039956434 §Add text to a path): the spine geometry for
 *  a text node's `onPath` target - the path's outline walk in the text node's
 *  local space (callers paint at sx/sy + local*z). Null when the target is
 *  gone or has no outline. */
export function onPathGeometry(
  root: XNode,
  n: XNode,
): { dx: number; dy: number; walk: OutlineWalk } | null {
  if (!n.onPath) return null;
  const pw = worldPos(root, n.onPath);
  const tw = worldPos(root, n.id);
  const pn = pw?.node;
  if (!pw || !tw || !pn) return null;
  const walk = outlineWalk(pn);
  if (!walk) return null;
  return { dx: pw.x - tw.x, dy: pw.y - tw.y, walk };
}

/** Nearest node whose outline passes within `r` of the world point - the text
 *  tool's path snap. Text/image layers and locked or hidden ones are out. */
function nearOutline(root: XNode, x: number, y: number, r: number): XNode | null {
  let best: XNode | null = null;
  let bestD = r;
  const visit = (n: XNode) => {
    if (n.visible !== false && !n.locked && n.kind !== "text") {
      const w = outlineWalk(n);
      const wp = worldPos(root, n.id);
      if (w && wp) {
        const { dist } = walkNearest(w, x - wp.x, y - wp.y);
        if (dist < bestD) {
          bestD = dist;
          best = n;
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return best;
}

/** Lay the text along its path: each glyph is placed at its arc-length spot,
 *  rotated to the tangent, baseline sitting on the path. `pathSide: "right"`
 *  (Flip text orientation) turns the glyphs to the other side. Char-by-char
 *  measure loses kerning across the join (recorded residual). */
function paintOnPath(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  geom: { dx: number; dy: number; walk: OutlineWalk },
  sx: number,
  sy: number,
  z: number,
) {
  const content = applyTextCase(n.text || "", n.textCase);
  if (!content) return;
  const flip = n.pathSide === "right";
  const runs = resolvedTextSpans(n);
  const styleAt = (i: number) => runs.find((r) => r.start <= i && r.end > i) ?? runs[0];
  const start = Math.max(0, Math.min(1, n.pathStart ?? 0)) * geom.walk.len;
  let adv = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const run = styleAt(i);
    const size = Math.max(1, (run?.fontSize ?? n.fontSize) * z);
    const ls = (n.letterSpacing || 0) * z;
    if (ch === "\n") {
      adv += size * 0.5 + ls;
      continue;
    }
    ctx.font = canvasTextFont(n, size, run);
    const cw = ctx.measureText(ch).width;
    const d = start + adv + cw / 2;
    const p = walkAt(geom.walk, d);
    const paint = run?.fill && run.fill !== n.fill ? cssRgba(run.fill) : n.fill;
    ctx.save();
    ctx.translate(sx + (geom.dx + p.x) * z, sy + (geom.dy + p.y) * z);
    // Flip text orientation: the glyphs turn over to the other side of the
    // path, reading along it from there.
    ctx.rotate(flip ? p.a + Math.PI : p.a);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (typeof paint === "string") ctx.fillStyle = paint;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    adv += cw + ls;
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
  geom?: { dx: number; dy: number; walk: OutlineWalk } | null,
) {
  if (n.onPath && geom) {
    paintOnPath(ctx, n, geom, sx, sy, z);
    return;
  }
  if (hasMixedTextSpans(n)) {
    paintStyledText(ctx, n, sx, sy, sw, sh, z);
    return;
  }
  const uniform = n.textRuns?.length ? resolvedTextSpans(n)[0] : undefined;
  const textFill = uniform?.fill && uniform.fill !== n.fill ? cssRgba(uniform.fill) : fillStyle(ctx, n, sx, sy, sw, sh);
  const size = Math.max(1, (uniform?.fontSize ?? n.fontSize) * z);
  // Small caps rides the font's own small-cap glyphs (with the copy lowered
  // so every letter takes part), not full-height capitals.
  ctx.font = uniform ? canvasTextFont(n, uniform.fontSize * z, uniform) : canvasTextFont(n, size);
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
  content = applyTextCase(content, n.textCase);
  // Tight leading stays tight: the floor is degenerate input, not the font
  // size, so the painter agrees with the hug box and the field. Percent
  // leading resolves against the font size (360039956634 §Line height).
  const lh = Math.max(1, effectiveLineHeight(n, uniform?.fontSize ?? n.fontSize) * z);
  const ls = (n.letterSpacing || 0) * z;
  const paraGap = (n.paragraphSpacing || 0) * z;
  const listGap = (n.listSpacing || 0) * z;
  const wrap = n.sizingW !== "hug";
  const paras = content.split("\n");
  const indent = indentOf(n) * z;
  type Row = {
    line: string; lastInPara: boolean; lead: number; marker: string;
    markerX: number; hangQ: number; itemGap: boolean; pi: number;
  };
  const rows: Row[] = [];
  const widthOfLine = (line: string) =>
    measureCached(ctx, line) + (ls ? ls * Math.max(0, line.length - 1) : 0);
  const counters = listCounters(n, paras.length);
  // A list's marker sits beside (or, hanging, outside) the paragraph and the
  // non-hanging gutter shrinks the width the wrapper may use; paragraphIndent
  // then offsets the first line of each paragraph.
  paras.forEach((para, pi) => {
    const ll = listLayout(n, pi, counters[pi], (s) => widthOfLine(s));
    const wrapStyle = paraWrapOf(n, pi);
    const avail = wrap ? sw - ll.textLead - indent : 1e6;
    let wrapped = wrapLines(ctx, para || " ", avail > 0 ? avail : 1e6, ls);
    // Wrap style only has something to say when the layer wraps: an
    // auto-width layer breaks a line exactly where Return was pressed.
    if (wrap && (wrapStyle === "balance" || wrapStyle === "pretty") && sw > 0)
      wrapped = balanceLines(wrapped, avail, widthOfLine, wrapStyle);
    // Hanging quotes (360040449773): an opening quote on the first line
    // moves outside the bounding box so the text aligns with it.
    const quote = n.hangingQuotes ? (para || "").match(/^["'\u201c\u2018\u00ab]/u)?.[0] ?? "" : "";
    const hangQ = quote ? widthOfLine(quote) : 0;
    wrapped.forEach((line, i) =>
      rows.push({
        line: para ? line : "",
        lastInPara: i === wrapped.length - 1,
        lead: ll.textLead + (i === 0 ? indent : 0),
        marker: i === 0 && para ? ll.marker : "",
        markerX: ll.markerX,
        hangQ: i === 0 ? hangQ : 0,
        itemGap: i === wrapped.length - 1 && paraListStyle(n, pi) !== "none"
          && pi + 1 < paras.length && paraListStyle(n, pi + 1) !== "none",
        pi,
      }),
    );
  });
  let lines = rows;
  if (n.truncate) {
    // Fixed-size layers have no max-lines setting: the box itself decides
    // how many rows survive, with the ellipsis on the last one that fits.
    const limit = valignApplies(n) || (n.maxH ?? 0) > 0
      ? fitLineCount(sh / Math.max(1e-6, z), effectiveLineHeight(n, uniform?.fontSize ?? n.fontSize), n.paragraphSpacing || 0)
      : n.maxLines > 0 ? Math.max(1, n.maxLines) : Infinity;
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
  const blockH =
    lines.reduce((h, r) => h + lh + (r.lastInPara ? paraGap + (r.itemGap ? listGap : 0) : 0), 0) -
    (lines.length && lines[lines.length - 1].lastInPara
      ? paraGap + (lines[lines.length - 1].itemGap ? listGap : 0)
      : 0);
  // Vertical trim (360039956634 §Vertical trim): "remove the extra space above
  // and below text" - the box hugs from the cap height to the baseline. The
  // trims approximate Inter's (ascent − cap) and descent ratios; recorded as
  // an approximation pending font metrics. The same inset (vertical alignment
  // included) is what the editor overlay hangs its text from, so the first row
  // cannot move when edit starts.
  let y0 = sy + firstRowInset(n, sh, blockH, uniform?.fontSize ?? n.fontSize, z);
  const drops = (n.effects ?? []).filter((e) => e.kind === "drop-shadow" && e.visible);
  const setDrop = (drop?: Effect) => {
    if (!drop) {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      return;
    }
    const { r, g, b, a } = parseHex(drop.color);
    ctx.shadowColor = `rgba(${r},${g},${b},${a})`;
    ctx.shadowBlur = Math.max(0, drop.blur) * z;
    ctx.shadowOffsetX = drop.x * z;
    ctx.shadowOffsetY = drop.y * z;
  };
  const fillOn = n.fillVisible !== false && !isNone(n.fill);
  const strokeOn = n.strokeVisible && n.strokeWidth > 0 && (n.strokeType === "pattern" || !isNone(n.strokePaint));
  const textStroke = n.strokeType === "pattern"
    ? patternStrokeStyle(ctx, n, sx, sy, z) ?? "rgba(0,0,0,0)"
    : cssRgba(n.strokePaint);
  // Numbers (360039956634 §Numbers) "Faux typography": without dedicated
  // super/subscript glyphs Figma "shr[inks] it and position[s] it accordingly"
  // - 0.7em glyphs raised toward the superscript line or dropped below the
  // baseline. Ratios recorded as an approximation of Figma's synthesized form.
  const faux = n.baselineShift === "super" || n.baselineShift === "sub";
  const fauxFont = faux ? canvasTextFont(n, size * 0.7, uniform) : "";
  const fauxDY = faux ? (n.baselineShift === "super" ? -size * 0.14 : size * 0.38) : 0;
  const paintFillLine = (str: string, x: number, y: number, maxW?: number) => {
    if (!fillOn) return;
    ctx.save();
    ctx.fillStyle = textFill;
    ctx.globalAlpha *= n.fillOpacity ?? 1;
    if (faux) {
      ctx.font = fauxFont;
      ctx.fillText(str, x, y + fauxDY);
    } else ctx.fillText(str, x, y, maxW);
    ctx.restore();
  };
  const paintStrokeLine = (str: string, x: number, y: number, maxW?: number) => {
    if (!strokeOn) return;
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = textStroke;
    ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
    ctx.miterLimit = strokeCanvasMiterLimit(n.strokeMiterAngle);
    ctx.globalAlpha *= n.strokeOpacity ?? 1;
    ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
    if (faux) {
      ctx.font = fauxFont;
      ctx.strokeText(str, x, y + fauxDY);
    } else ctx.strokeText(str, x, y, maxW);
    ctx.restore();
  };
  const paintRows = (mode: "fill" | "stroke" | "none", decorate: "none" | "underline" | "all") => {
  let ty = y0;
  lines.forEach((row) => {
    // RTL/bidi (4972283635863): each paragraph resolves its direction -
    // an explicit override, else the language detection of its content.
    ctx.direction = directionOf(row.line, n.paraDir?.[row.pi] ?? n.textDirection);
    const fullLine = row.line;
    let line = fullLine;
    const left = sx + row.lead;
    const innerW = Math.max(0, sw - row.lead);
    const paintLine = mode === "fill" ? paintFillLine : paintStrokeLine;
    // Hanging quotes draw the opening quote outside the box; the rest of the
    // line sits on the paragraph's lead.
    if (row.hangQ > 0 && line) {
      const q = line.slice(0, 1);
      line = line.slice(1);
      if (mode !== "none") paintLine(q, sx + row.lead - row.hangQ, ty);
    }
    const tx =
      n.textAlign === "center"
        ? left + innerW / 2
        : n.textAlign === "right"
          ? sx + sw
          : left;
    const justify = n.textAlign === "justified" && wrap && !row.lastInPara && line.includes(" ");
    if (mode !== "none") {
      if (row.marker) paintLine(row.marker, sx + row.lead + row.markerX, ty);
      if (justify) {
        const words = line.trim().split(/\s+/);
        const widths = words.map((w) => measureCached(ctx, w) + ls * Math.max(0, w.length - 1));
        const total = widths.reduce((s, w) => s + w, 0);
        // Letter-spacing still applies between the words; the distributed gap
        // rides on top of it, as word-spacing does in CSS.
        const gap = words.length > 1 ? (innerW - total - ls * (words.length - 1)) / (words.length - 1) : 0;
        let x = left;
        ctx.textAlign = "left";
        for (let wi = 0; wi < words.length; wi++) {
          paintLine(words[wi], x, ty);
          x += widths[wi] + ls + gap;
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
    }
    const drawUnderline = n.textDecoration === "underline" && (decorate === "underline" || (decorate === "all" && !n.underlineSkipInk));
    const drawStrike = n.textDecoration === "strikethrough" && decorate === "all";
    if (fillOn && (drawUnderline || drawStrike)) {
      const textWidth = justify ? innerW : measureCached(ctx, fullLine) + ls * Math.max(0, fullLine.length - 1);
      const x0 =
        (justify ? left : n.textAlign === "center" ? tx - textWidth / 2 : n.textAlign === "right" ? tx - textWidth : tx) -
        row.hangQ;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.globalAlpha *= n.fillOpacity ?? 1;
      if (drawUnderline) {
        // Underline hugs the baseline plus its offset; the details (360039956634
        // §Decoration) choose the line style, weight and color.
        const yy = ty + size + (n.underlineOffset ?? 0) * z;
        const uW = Math.max(0.5, (n.underlineThickness ?? 1) * z);
        ctx.strokeStyle = cssRgba(n.underlineColor ?? uniform?.fill ?? n.fill);
        ctx.lineWidth = uW;
        if ((n.underlineStyle ?? "solid") === "dotted") ctx.setLineDash([uW, uW * 2]);
        ctx.beginPath();
        if ((n.underlineStyle ?? "solid") === "wavy") {
          const amp = Math.max(1, uW * 1.5);
          for (let x = x0; x < x0 + textWidth; x += amp * 2) {
            ctx.moveTo(x, yy);
            ctx.quadraticCurveTo(x + amp / 2, yy - amp, x + amp, yy);
            ctx.quadraticCurveTo(x + amp * 1.5, yy + amp, x + amp * 2, yy);
          }
        } else {
          ctx.moveTo(x0, yy);
          ctx.lineTo(x0 + textWidth, yy);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (drawStrike) {
        // Strikethrough crosses mid x-height.
        const yy = ty + size * 0.7;
        ctx.strokeStyle = cssRgba(uniform?.fill ?? n.fill);
        ctx.lineWidth = Math.max(1, z);
        ctx.beginPath();
        ctx.moveTo(x0, yy);
        ctx.lineTo(x0 + textWidth, yy);
        ctx.stroke();
      }
      if (n.slashedZero && line.includes("0")) {
        // Slashed zero (§Numbers): a synthesised diagonal through each 0.
        ctx.strokeStyle = cssRgba(uniform?.fill ?? n.fill);
        ctx.lineWidth = Math.max(1, size * 0.06);
        const t0 = x0 + row.hangQ;
        let acc = 0;
        for (const ch of line) {
          const w = measureCached(ctx, ch) + ls;
          if (ch === "0") {
            const gW = w - ls;
            ctx.beginPath();
            ctx.moveTo(t0 + acc + gW * 0.18, ty + size * 0.8);
            ctx.lineTo(t0 + acc + gW * 0.82, ty + size * 0.1);
            ctx.stroke();
          }
          acc += w;
        }
      }
      ctx.restore();
    }
    ty += lh + (row.lastInPara ? paraGap + (row.itemGap ? listGap : 0) : 0);
  });
  };
  // Every visible drop gets its own pass: the glyphs repaint identically, so
  // N shadows accumulate behind one set of glyphs. Native shadows cannot
  // blend independently, so text shadows always composite Normal; spread
  // stays ignored on text, matching Figma's kind gate.
  // Skip ink (360039956634 §Decoration): "the underline will skip areas where
  // the part of a glyph character crosses an underline" - painted under the
  // glyphs so their opaque ink covers it, which is exactly that skip.
  if (n.textDecoration === "underline" && n.underlineSkipInk) paintRows("none", "underline");
  const passes = drops.length ? drops : [undefined];
  for (const d of passes) {
    setDrop(d);
    paintRows("fill", "none");
  }
  setDrop(undefined);
  paintRows("stroke", "all");
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

/** §23 PT-005: true when `id` is `anc` or nested under it. */
function isSelfOrDescendant(root: XNode, id: string, anc: string): boolean {
  if (id === anc) return true;
  let p = findParent(root, id);
  while (p) {
    if (p.id === anc) return true;
    p = findParent(root, p.id);
  }
  return false;
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
        // §23 PT-009: every trigger names itself — After-delay/key/enter rows
        // used to borrow "On drag" on the connection chip.
        const trigLabel =
          ix.trigger === "onClick" ? "On click"
          : ix.trigger === "onHover" ? "While hovering"
          : ix.trigger === "afterDelay" ? "After delay"
          : ix.trigger === "mouseEnter" ? "Mouse enter"
          : ix.trigger === "mouseLeave" ? "Mouse leave"
          : ix.trigger === "mouseDown" ? "Mouse down"
          : ix.trigger === "mouseUp" ? "Mouse up"
          : ix.trigger === "keyPress" ? `Key (${ix.keyKey || "…"})`
          : "On drag";
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
    const o = getCanvas2dContext(oc);
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
  const o = getCanvas2dContext(oc);
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
