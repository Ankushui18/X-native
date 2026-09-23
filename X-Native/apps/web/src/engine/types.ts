/**
 * Document types that mirror `x-core::Node` / `.x` JSON enough for the
 * designer chrome. WASM `x-editor` can implement the same command API later.
 */

export type NodeKind =
  | "frame"
  | "group"
  | "rect"
  | "ellipse"
  | "text"
  | "line"
  | "arrow"
  | "poly"
  | "star"
  | "vector"
  | "boolean"
  | "component"
  | "instance";

export type Overflow = "visible" | "clip" | "scrollx" | "scrolly" | "scrollboth";
export type Sizing = "fixed" | "hug" | "fill";
export type LayoutDirection = "horizontal" | "vertical";
export type LayoutAlign = "min" | "center" | "max" | "baseline";
export type LayoutJustify = "min" | "center" | "max" | "between";
export type TextAlign = "left" | "center" | "right" | "justified";
export type TextAlignVertical = "top" | "middle" | "bottom";
export type TextDecoration = "none" | "underline" | "strikethrough";
export type TextCase = "none" | "upper" | "lower" | "title" | "small-caps";
export type StrokeAlign = "inside" | "center" | "outside";
export type StrokeCap = "none" | "round" | "square" | "arrow" | "triangle";
export type StrokeJoin = "miter" | "bevel" | "round";
export type Constraint = "min" | "center" | "max" | "stretch" | "scale";
export type ExportFormat = "PNG" | "JPG" | "SVG" | "PDF";
export type RightTab = "design" | "prototype" | "inspect";
export type LeftTab = "layers" | "assets" | "tokens";
export type FillType = "solid" | "linear" | "radial" | "angular" | "diamond" | "image";
export type ImageFit = "fill" | "fit" | "crop" | "tile";
export type EffectKind =
  | "drop-shadow"
  | "inner-shadow"
  | "layer-blur"
  | "background-blur"
  | "noise"
  | "glass"
  | "texture";
export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";
export type ProtoTrigger =
  | "onClick"
  | "onHover"
  | "afterDelay"
  | "mouseEnter"
  | "mouseLeave"
  | "mouseDown"
  | "mouseUp"
  | "keyPress"
  | "onDrag";
export type ProtoAction =
  | "navigate"
  | "back"
  | "scrollTo"
  | "openOverlay"
  | "closeOverlay"
  | "swapOverlay"
  | "openUrl"
  | "setVariable";
export type ProtoAnim =
  | "instant"
  | "dissolve"
  | "smart"
  | "slideInLeft"
  | "slideInRight"
  | "slideInTop"
  | "slideInBottom"
  | "pushLeft"
  | "pushRight";

export type ProtoDevice =
  | "iphone-16-pro"
  | "pixel-9"
  | "ipad-pro"
  | "macbook-pro"
  | "apple-watch"
  | "none";

export type VariableType = "color" | "number" | "string" | "boolean";

export interface VariableItem {
  id: string;
  name: string;
  type: VariableType;
  value: string | number | boolean;
  collection: string;
}

export interface AnnotationItem {
  id: string;
  nodeId: string;
  note: string;
  author?: string;
  date?: string;
}

export interface PathPoint {
  x: number;
  y: number;
  /** Incoming bezier handle, relative to the point (Figma pen). */
  ix?: number;
  iy?: number;
  /** Outgoing bezier handle, relative to the point. */
  ox?: number;
  oy?: number;
  mirrorMode?: "none" | "angle" | "angleAndLength";
  cornerRadius?: number;
}

/**
 * Evan Wallace / Figma Vector Network Model.
 * Represents vector paths as an arbitrary planar graph where vertices
 * can connect to 3 or more segments (branching, T-junctions, interior faces).
 */
export interface VectorVertex {
  x: number;
  y: number;
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  cornerRadius?: number;
}

export interface VectorSegment {
  start: number; // index into vertices
  end: number;   // index into vertices
  tangentStart?: { x: number; y: number }; // relative handle from start vertex
  tangentEnd?: { x: number; y: number };   // relative handle from end vertex
}

export interface VectorRegion {
  windingRule?: "NONZERO" | "EVENODD";
  loops: number[][]; // array of vertex index sequences forming closed loops
}

export interface VectorNetwork {
  vertices: VectorVertex[];
  segments: VectorSegment[];
  regions?: VectorRegion[];
}

export type ProtoEasing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "spring" | "bouncy";

export interface Interaction {
  trigger: ProtoTrigger;
  action: ProtoAction;
  destination: string;
  animation: ProtoAnim;
  delay: number;
  duration?: number;
  easing?: ProtoEasing;
  smartMatch?: boolean;
  overlayPosition?: "center" | "top" | "bottom" | "left" | "right" | "manual";
  overlayCloseOutside?: boolean;
  overlayBackdrop?: boolean;
  overlayBackdropColor?: string;
  keyKey?: string;
  variableId?: string;
  variableOp?: "set" | "increment" | "decrement" | "toggle";
  variableValue?: string | number | boolean;
}

export interface ComponentVariant {
  name: string;
  node: XNode;
}

/**
 * A named, reusable paint definition — Figma's colour styles.
 *
 * A style owns the paint; nodes reference it by id through `XNode.fillStyle` /
 * `XNode.strokeStyle`. Editing the style repaints every node bound to it,
 * which is the whole point: the binding is live, not a one-off copy.
 *
 * Scoped to solid paints for now. Text and effect styles reuse the same store
 * shape when they arrive, which is why the kind is explicit rather than
 * implied by which array it lives in.
 */
export interface SharedStyle {
  id: string;
  name: string;
  kind: "paint";
  /** #rrggbb or #rrggbbaa, matching every other colour field in the engine. */
  color: string;
}

export interface ComponentPropertyDef {
  id: string;
  name: string;
  type: "variant" | "boolean" | "text";
  defaultValue: string | boolean;
  targetNodeName?: string;
}

export interface ComponentMaster {
  id: string;
  name: string;
  node: XNode;
  variants: ComponentVariant[];
  property: string;
  properties?: ComponentPropertyDef[];
}

export interface ExportPreset {
  format: ExportFormat;
  scale: number;
  suffix: string;
}

/**
 * One colour stop on a gradient ramp.
 *
 * `position` is 0..1 along the gradient axis. When `XNode.gradientStops` is
 * empty the renderer falls back to the legacy two-colour `fill` → `fillB`
 * ramp, so existing documents keep working.
 */
export interface GradientStop {
  color: string;
  position: number;
}

/**
 * A character-level rich text styling run (matching x-core::TextRun).
 */
export interface TextRun {
  start: number;
  end: number;
  fill?: string;
  fontWeight?: number;
  fontSize?: number;
  fontFamily?: string;
  textDecoration?: TextDecoration;
}

/**
 * One entry in a node's fill stack.
 *
 * Figma paints a list of fills bottom-to-top. The existing scalar `fill`/
 * `fillType`/`gradientStops` fields on XNode describe the *bottom* fill and
 * remain authoritative on their own, so every existing call site keeps working.
 * `XNode.fills` holds any *additional* fills painted over it; an empty or
 * absent array means "single fill", which is the legacy behaviour.
 */
export interface Paint {
  type: FillType;
  color: string;
  opacity: number;
  visible: boolean;
  blend?: string;
  /** Gradient geometry, normalised 0..1 within the node box. */
  gx?: number;
  gy?: number;
  hx?: number;
  hy?: number;
  stops?: GradientStop[];
}

/**
 * One additional stroke, painted over the base stroke.
 *
 * Same split as fills: the scalar `strokePaint`/`strokeWidth`/… fields on
 * XNode describe the *bottom* stroke and stay authoritative on their own, so
 * every existing call site keeps working. `XNode.strokes` holds any extra
 * strokes drawn on top, bottom-to-top, the way Figma stacks them. An empty or
 * absent array means "single stroke", which is the legacy behaviour.
 *
 * Each layer carries its own geometry (width, align, dash, caps) because in
 * Figma a second stroke is a genuinely independent outline, not a recolour of
 * the first.
 */
export interface StrokeLayer {
  color: string;
  opacity: number;
  visible: boolean;
  width: number;
  align: StrokeAlign;
  dash?: number;
  gap?: number;
  cap?: StrokeCap;
  join?: StrokeJoin;
}

export interface Effect {
  kind: EffectKind;
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  visible: boolean;
}

export type Tool =
  | "select"
  | "scale"
  | "frame"
  | "section"
  | "slice"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "poly"
  | "star"
  | "image"
  | "pen"
  | "pencil"
  | "brush"
  | "eraser"
  | "comment"
  | "hand";

export interface AutoLayout {
  direction: LayoutDirection;
  gap: number;
  padding: [number, number, number, number];
  sizing: Sizing;
  cross: Sizing;
  wrap: boolean;
  align: LayoutAlign;
  justify: LayoutJustify;
  /** Canvas stacking: true = First on top, false = Last on top (Figma parity) */
  itemReverseZIndex?: boolean;
}

export type GridPattern = "columns" | "rows" | "grid";
export type GridAlignment = "stretch" | "center" | "min" | "max";

export interface LayoutGrid {
  id: string;
  pattern: GridPattern;
  sectionSize?: number;
  count?: number;
  gutter?: number;
  margin?: number;
  alignment?: GridAlignment;
  color?: string;
  visible?: boolean;
}

export interface ArcData {
  startingAngle: number;
  endingAngle: number;
  innerRadius: number;
}

export interface XNode {
  id: string;
  name: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  fill: string;
  fillOpacity: number;
  fillVisible: boolean;
  fillType: FillType;
  fillB: string;
  /**
   * Multi-stop gradient ramp. Empty means "use the legacy `fill`/`fillB` pair";
   * two or more entries take precedence over it.
   */
  gradientStops: GradientStop[];
  /**
   * Extra fills painted on top of the base `fill`, bottom-to-top, the way
   * Figma stacks them. Absent/empty means the node has a single fill.
   */
  fills?: Paint[];
  /** Extra strokes painted over the base stroke; see StrokeLayer. */
  strokes?: StrokeLayer[];
  /** Id of the SharedStyle driving `fill`, if the fill is bound to one.
   *  Editing that style updates this node; editing the node's colour directly
   *  detaches it, as in Figma. */
  fillStyle?: string;
  /** Id of the SharedStyle driving `strokePaint`. */
  strokeStyle?: string;
  fillBlend: string;
  strokePaint: string;
  strokeOpacity: number;
  strokeVisible: boolean;
  strokeWidth: number;
  strokeAlign: StrokeAlign;
  strokeDash: number;
  strokeGap: number;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  opacity: number;
  effects: Effect[];
  visible: boolean;
  locked: boolean;
  overflow: Overflow;
  cornerRadii: [number, number, number, number];
  cornerIndependent: boolean;
  aspectLocked: boolean;
  sizingW: Sizing;
  sizingH: Sizing;
  constraintH: Constraint;
  constraintV: Constraint;
  count: number;
  starRatio: number;
  showName: boolean;
  exports: ExportPreset[];
  blendMode: string;
  imageSrc: string;
  imageFit: ImageFit;
  imageRot: number;
  imageExposure: number;
  imageContrast: number;
  imageSaturation: number;
  imageTemperature: number;
  imageTint: number;
  imageHighlights: number;
  imageShadows: number;
  /** Set once the user renames a layer by hand, so automatic naming (e.g. a
   *  text layer following its content, as in Figma) stops overriding it. */
  nameLocked?: boolean;
  /** Sizing constraints (Figma min/max width & height) */
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  /** Figma's Absolute position inside auto-layout frame */
  absolutePosition?: boolean;
  /** Rich text formatting runs */
  textRuns?: TextRun[];
  /** Preserved per-instance property overrides */
  overrides?: Record<string, unknown>;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  textAlign: TextAlign;
  textAlignVertical: TextAlignVertical;
  textDecoration: TextDecoration;
  textCase: TextCase;
  truncate: boolean;
  maxLines: number;
  children: XNode[];
  layout: AutoLayout | null;
  path: PathPoint[];
  vectorNetwork?: VectorNetwork;
  closed: boolean;
  booleanOp: BooleanOp | null;
  componentId: string;
  isComponent: boolean;
  interactions: Interaction[];
  flipH: boolean;
  flipV: boolean;
  fillGX: number;
  fillGY: number;
  fillHX: number;
  fillHY: number;
  isMask: boolean;
  maskType: "alpha" | "vector" | "luminance";
  variant: string;
  componentProperties?: Record<string, string | boolean>;
  /** Figma frame layout grids (columns, rows, grid) */
  layoutGrids?: LayoutGrid[];
  /** Figma ellipse arc / donut properties */
  arcData?: ArcData;
}

/** A single message inside a comment thread. */
export interface CommentReply {
  id: string;
  body: string;
  at: number;
}

/** A comment pin anchored to a point in page space. Comments are annotations,
 *  not geometry: they live on the page rather than in the layer tree, so they
 *  never export, never hit-test as shapes and never appear as layers. */
export interface CommentThread {
  id: string;
  x: number;
  y: number;
  body: string;
  at: number;
  resolved: boolean;
  replies: CommentReply[];
}

/**
 * A ruler guide: an infinite line the user drags out of a ruler.
 *
 * Distinct from `snapping.Guide`, which is the transient red line drawn while
 * dragging a layer. These persist with the page and objects snap to them.
 */
export interface RulerGuide {
  id: string;
  axis: "x" | "y";
  /** Position in world units. */
  at: number;
}

export interface Page {
  id: string;
  name: string;
  root: XNode;
  comments: CommentThread[];
  /** Ruler guides for this page; see RulerGuide. */
  guides: RulerGuide[];
  pixelGrid: boolean;
  pixelGridColor: string;
  flowStart: string;
}

export interface Snapshot {
  fileName: string;
  pages: Page[];
  page: number;
  selection: string[];
  tool: Tool;
  zoom: number;
  panX: number;
  panY: number;
  rightTab: RightTab;
  leftTab: LeftTab;
  canUndo: boolean;
  canRedo: boolean;
  components: ComponentMaster[];
  /** Document-level named paints; see SharedStyle. */
  styles: SharedStyle[];
  presentFrame: string;
  presentStack: string[];
  prototypeDevice?: ProtoDevice;
  prototypeOrientation?: "portrait" | "landscape";
  prototypeScale?: "fit" | "100%" | "fill";
  prototypeHotspots?: boolean;
  prototypeLiveInputs?: boolean;
  prototypeSound?: boolean;
  activeOverlay?: {
    id: string;
    position?: "center" | "top" | "bottom" | "left" | "right" | "manual";
    closeOutside?: boolean;
    backdrop?: boolean;
    backdropColor?: string;
  } | null;
  /** Figma's View > Rulers (⇧R). */
  showRulers: boolean;
  /** Figma's View > Minimap. Off by default; it costs its own render pass. */
  showMinimap: boolean;
  /** Comment pins are hidden unless the comment tool is active or the user
   *  has explicitly turned them on, as in Figma. */
  showComments: boolean;
  /** Thread whose popover is open, if any. */
  openComment: string;
  /** Figma Variables / Tokens store */
  variables?: VariableItem[];
  /** Dev Mode Annotations store */
  annotations?: AnnotationItem[];
  /** Node ID currently in vector edit mode, if any. */
  vecEdit?: string | null;
  /** Active vector point index currently selected, if any. */
  vecPoint?: number | null;
  /** Selected vector point indices for multi-selection. */
  vecPoints?: number[];
}

export type Command =
  | { type: "select"; ids: string[] }
  | { type: "setTool"; tool: Tool }
  | { type: "setZoom"; zoom: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "setPan"; x: number; y: number }
  | { type: "setRightTab"; tab: RightTab }
  | { type: "toggleRulers" }
  | { type: "toggleMinimap" }
  | { type: "toggleComments" }
  | { type: "addComment"; x: number; y: number; body: string }
  | { type: "replyComment"; id: string; body: string }
  | { type: "resolveComment"; id: string; resolved: boolean }
  | { type: "deleteComment"; id: string }
  | { type: "moveComment"; id: string; x: number; y: number }
  | { type: "openComment"; id: string }
  | { type: "setLeftTab"; tab: LeftTab }
  | { type: "setPage"; index: number }
  | { type: "setFileName"; name: string }
  | { type: "addPage" }
  | {
      type: "add";
      kind: NodeKind;
      x: number;
      y: number;
      w: number;
      h: number;
      parent?: string;
      extra?: Partial<XNode>;
    }
  | { type: "move"; ids: string[]; dx: number; dy: number }
  | { type: "resize"; id: string; x: number; y: number; w: number; h: number; scaleProps?: boolean }
  | { type: "reparent"; ids: string[]; parent: string; x: number; y: number }
  /**
   * Move layers to an explicit slot in a parent's child list, preserving their
   * on-canvas position. This is what the layers-panel drag uses; `reparent`
   * always appends and is driven by canvas coordinates instead.
   */
  | { type: "reorder"; ids: string[]; parent: string; index: number }
  | { type: "delete" }
  | { type: "duplicate" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "patch"; id: string; patch: Partial<XNode> }
  | { type: "autoLayout"; id: string; layout: AutoLayout | null }
  | { type: "nudge"; dx: number; dy: number }
  | { type: "begin" }
  | { type: "end" }
  | { type: "cut" }
  | { type: "copy" }
  | { type: "paste"; x?: number; y?: number; inPlace?: boolean }
  | { type: "group" }
  | { type: "ungroup" }
  | { type: "wrapSection" }
  | { type: "arrange"; dir: "front" | "forward" | "backward" | "back" }
  | { type: "selectAll" }
  | { type: "lockSel" }
  | { type: "hideSel" }
  | { type: "copyCode" }
  | { type: "copyProperties" }
  | { type: "pasteProperties" }
  | { type: "deleteInteraction"; id: string; destId: string }
  | { type: "flip"; axis: "h" | "v" }
  | { type: "duplicatePage" }
  | { type: "deletePage" }
  | { type: "renamePage"; name: string }
  | { type: "patchPage"; patch: Partial<Pick<Page, "pixelGrid" | "pixelGridColor" | "name" | "flowStart">> }
  | { type: "distribute"; axis: "h" | "v" }
  | { type: "boolean"; op: BooleanOp }
  /** Create a named style from the selection's current fill or stroke and
   *  bind the selection to it. */
  | { type: "createStyle"; kind: "fill" | "stroke"; name: string }
  /** Point the selection at an existing style. */
  | { type: "applyStyle"; kind: "fill" | "stroke"; styleId: string }
  /** Drop the binding, keeping the painted colour. */
  | { type: "detachStyle"; kind: "fill" | "stroke" }
  /** Recolour a style; every bound node follows. */
  | { type: "editStyle"; id: string; color?: string; name?: string }
  | { type: "deleteStyle"; id: string }
  | { type: "addGuide"; axis: "x" | "y"; at: number }
  | { type: "moveGuide"; id: string; at: number }
  | { type: "removeGuide"; id: string }
  | { type: "makeComponent" }
  | { type: "detachInstance" }
  | { type: "placeComponent"; id: string; x: number; y: number }
  | { type: "addPath"; points: PathPoint[]; closed: boolean }
  | { type: "patchPath"; id: string; path: PathPoint[]; closed?: boolean }
  | { type: "patchVectorNetwork"; id: string; network: VectorNetwork }
  | { type: "addVectorBranch"; id: string; fromVertexIndex: number; to: VectorVertex; tangentStart?: { x: number; y: number }; tangentEnd?: { x: number; y: number } }
  | { type: "bendSegment"; id: string; segIndex: number; dragX: number; dragY: number }
  | { type: "insertPointOnPath"; id: string; x: number; y: number }
  | { type: "setPointMirror"; id: string; pointIndex: number; mode: "none" | "angle" | "angleAndLength" }
  | { type: "setPointCornerRadius"; id: string; pointIndex: number; radius: number }
  | { type: "flatten" }
  | { type: "outlineStroke" }
  | { type: "addVariant"; name: string }
  | { type: "setVariant"; id: string; name: string }
  | { type: "setVecEdit"; id: string | null; pointIndex?: number | null; pointIndices?: number[] }
  | { type: "addComponentProperty"; componentId: string; property: ComponentPropertyDef }
  | { type: "deleteComponentProperty"; componentId: string; propId: string }
  | { type: "setComponentProperty"; id: string; propName: string; value: string | boolean }
  | { type: "resetOverrides"; id?: string; property?: string }
  | { type: "setInteractions"; id: string; interactions: Interaction[] }
  | { type: "addVariable"; variable: VariableItem }
  | { type: "patchVariable"; id: string; patch: Partial<VariableItem> }
  | { type: "deleteVariable"; id: string }
  | { type: "addAnnotation"; annotation: AnnotationItem }
  | { type: "deleteAnnotation"; id: string }
  | { type: "presentStart"; id?: string }
  | { type: "presentGo"; id: string }
  | { type: "presentBack" }
  | { type: "presentStop" }
  | { type: "setPrototypeDevice"; device: ProtoDevice }
  | { type: "setPrototypeOrientation"; orientation: "portrait" | "landscape" }
  | { type: "setPrototypeScale"; scale: "fit" | "100%" | "fill" }
  | { type: "togglePrototypeHotspots"; enabled?: boolean }
  | { type: "togglePrototypeLiveInputs"; enabled?: boolean }
  | { type: "togglePrototypeSound"; enabled?: boolean }
  | {
      type: "openOverlay";
      id: string;
      position?: "center" | "top" | "bottom" | "left" | "right" | "manual";
      closeOutside?: boolean;
      backdrop?: boolean;
      backdropColor?: string;
    }
  | { type: "closeOverlay" };

export interface Engine {
  snapshot(): Snapshot;
  subscribe(fn: () => void): () => void;
  dispatch(cmd: Command): void;
}

export const TOOL_META: {
  id: Tool;
  label: string;
  shortcut: string;
}[] = [
  { id: "select", label: "Move", shortcut: "V" },
  { id: "scale", label: "Scale", shortcut: "K" },
  { id: "frame", label: "Frame", shortcut: "F" },
  { id: "section", label: "Section", shortcut: "⇧S" },
  { id: "slice", label: "Slice", shortcut: "S" },
  { id: "text", label: "Text", shortcut: "T" },
  { id: "rect", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "line", label: "Line", shortcut: "L" },
  { id: "arrow", label: "Arrow", shortcut: "⇧L" },
  { id: "poly", label: "Polygon", shortcut: "" },
  { id: "star", label: "Star", shortcut: "" },
  { id: "image", label: "Image", shortcut: "⇧I" },
  { id: "pen", label: "Pen", shortcut: "P" },
  { id: "pencil", label: "Pencil", shortcut: "⇧P" },
  { id: "brush", label: "Brush", shortcut: "B" },
  { id: "eraser", label: "Eraser", shortcut: "" },
  { id: "comment", label: "Comment", shortcut: "C" },
  { id: "hand", label: "Hand", shortcut: "H" },
];
