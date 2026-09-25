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
export type LayoutDirection = "horizontal" | "vertical" | "grid";
/**
 * How a grid track is sized, Three options for a column or a row.
 *
 * - `hug` keeps the smallest track the objects in it need.
 * - `fill` shares the leftover space by fractional unit - the article's `fr`:
 *   "Track proportion = Number of fractional units applied to the current track
 *   ÷ Total number of fractional units across all tracks on the same dimension".
 * - `fixed` stays the size it is, whatever the frame does.
 */
export type TrackMode = "fixed" | "fill" | "hug";

export interface GridTrack {
  mode: TrackMode;
  /** Fractional units, only meaningful when `mode` is `"fill"` (1fr default). */
  fr?: number;
  /** The pinned size, only meaningful when `mode` is `"fixed"`. */
  size?: number;
}
export type LayoutAlign = "min" | "center" | "max" | "baseline";
export type LayoutJustify = "min" | "center" | "max" | "between";
export type TextAlign = "left" | "center" | "right" | "justified";
export type TextAlignVertical = "top" | "middle" | "bottom";
/**
 * How a wrapped paragraph breaks its lines - the type setting for
 * "Wrap style". Mirrors x-core's TextWrap enum, which rides the node as the
 * "tw" binding: Auto is the greedy first-fit, Balance evens the line lengths
 * out per paragraph, Pretty balances and keeps a lone word off the last line.
 */
export type TextWrap = "auto" | "balance" | "pretty";
/**
 * Paragraph markers, x-core's ListStyle. Bulleted and numbered both hang a
 * marker in the gutter and indent the paragraph beside it.
 */
export type ListStyle = "none" | "bulleted" | "numbered";
export type TextDecoration = "none" | "underline" | "strikethrough";
export type TextCase = "none" | "upper" | "lower" | "title" | "small-caps";
export type StrokeAlign = "inside" | "center" | "outside";
export type StrokeCap =
  | "none"
  | "round"
  | "square"
  | "arrow"
  | "triangle"
  | "reverse-triangle"
  | "diamond";
/** Individual strokes picker; `custom` keeps a weight per side. */
export type StrokeSides = "all" | "top" | "right" | "bottom" | "left" | "custom";
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
  | "iphone-se"
  | "pixel-9"
  | "ipad-pro"
  | "macbook-pro"
  | "desktop"
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
  /** Incoming bezier handle, relative to the point (Pen tool). */
  ix?: number;
  iy?: number;
  /** Outgoing bezier handle, relative to the point. */
  ox?: number;
  oy?: number;
  mirrorMode?: "none" | "angle" | "angleAndLength";
  cornerRadius?: number;
}

/**
 * Vector Network Model.
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
 * A named, reusable paint definition — reusable color styles.
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
  /** Scale field: a multiplier, or a size with a unit. A number is
   *  read as a multiplier, the strings "500w" and "300h" as a fixed width or
   *  height with the other side following the aspect ratio. */
  scale: number | string;
  suffix: string;
  /** Format-specific settings. All optional: a preset saved before these
   *  existed reads through `resolveSettings`, which fills in default settings
   *  rather than treating a missing boolean as off. */
  ignoreOverlap?: boolean;
  boundingBox?: boolean;
  includeId?: boolean;
  outlineText?: boolean;
  simplifyStroke?: boolean;
  quality?: "low" | "medium" | "high";
  resampling?: "detailed" | "basic";
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
 * List of fills paints bottom-to-top. The existing scalar `fill`/
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
 * strokes drawn on top, bottom-to-top, in bottom-to-top order. An empty or
 * absent array means "single stroke", which is the legacy behaviour.
 *
 * Each layer carries its own geometry (width, align, dash, caps) because in
 * a second stroke is a genuinely independent outline, not a recolour of
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
  /** Same per-side picker the base stroke has, per stroke layer. */
  sides?: StrokeSides;
  sideW?: [number, number, number, number];
  /** Custom dash sequence for this stroke, `dash, gap, dash, gap…`. */
  pattern?: number[];
}

export interface Effect {
  kind: EffectKind;
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  visible: boolean;
  /** How this effect blends with what is already on the canvas. Only inner
   *  shadows, drop shadows and noise offer it; "Normal" is the
   *  default, and "Pass through" is not available to fills or effects. */
  blend?: string;
  /** Drop shadows only. Checkbox; off by default, which means the
   *  shadow is masked by whatever the layer actually paints, so a stroke-only
   *  layer casts the shadow of its ring rather than of the whole outline. */
  showBehind?: boolean;
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
  | "hand"
  /** Zoom tool: click to zoom in, ⌥-click out, drag to a region. */
  | "zoom";

export interface AutoLayout {
  direction: LayoutDirection;
  gap: number;
  padding: [number, number, number, number];
  sizing: Sizing;
  cross: Sizing;
  wrap: boolean;
  align: LayoutAlign;
  justify: LayoutJustify;
  /** Auto gap. When `"auto"`, `gap` is ignored and the space left over
   *  is distributed by `spacing` - which is what makes a frame's contents sit
   *  against its padding, or evenly through it, as the frame is resized. */
  gapMode?: "fixed" | "auto";
  spacing?: "between" | "around" | "evenly";
  /** Canvas stacking: true = First on top, false = Last on top (canvas stacking) */
  itemReverseZIndex?: boolean;
  /* ── The grid flow ────────────────────────────────────────────────────────
   * Grid flow, "Use the grid in auto layout flow": cells arranged
   * into columns and rows, where an object can span several of each. Only read
   * when `direction` is `"grid"`. */
  /** Number of columns. */
  columns?: number;
  /** Number of rows, or `"auto"` - the default, where rows appear and vanish
   *  with the objects that need them. */
  rows?: number | "auto";
  /** "Gap between rows" - the vertical gap between tracks. */
  gapRows?: number;
  /** "Gap between columns" - falls back to `gap` for documents written before
   *  the two were separate. */
  gapCols?: number;
  /** Per-track sizing; a missing entry is a hug. */
  colTracks?: GridTrack[];
  rowTracks?: GridTrack[];
  /** Automatic positioning, on by default: objects flow left to right
   *  from the top row. Switching it off keeps every object in the cell it is
   *  in, which is how empty cells survive a deletion. */
  autoPosition?: boolean;
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
  /** Where the layer turns about, as a fraction of its own box: [0.5, 0.5] is
   *  the centre, which is default. `⌥R` reveals a target that drags
   *  this point, and rotating then slides the box so the point stays put. */
  rotOrigin?: [number, number];
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
   * stacked order. Absent/empty means the node has a single fill.
   */
  fills?: Paint[];
  /** Extra strokes painted over the base stroke; see StrokeLayer. */
  strokes?: StrokeLayer[];
  /** Id of the SharedStyle driving `fill`, if the fill is bound to one.
   *  Editing that style updates this node; editing the node's colour directly
   *  detaches it. */
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
  strokeCapStart?: StrokeCap;
  strokeCapEnd?: StrokeCap;
  strokeJoin: StrokeJoin;
  opacity: number;
  effects: Effect[];
  visible: boolean;
  locked: boolean;
  overflow: Overflow;
  cornerRadii: [number, number, number, number];
  cornerIndependent: boolean;
  /**
   * Corner smoothing, 0-1: keeps the radius but flattens the corner's
   * shoulders into a squircle. A whole-shape property, never per corner, which
   * is why it sits next to `cornerIndependent` rather than inside `cornerRadii`.
   */
  cornerSmoothing?: number;
  /**
   * Which sides of a rectangle/frame/component/instance carry the stroke.
   * Individual strokes: the four pickers plus `custom`,
   * which lets every side keep its own weight.
   */
  strokeSides?: StrokeSides;
  /** Per-side weights in [top, right, bottom, left] order, used by `custom`. */
  strokeSideW?: [number, number, number, number];
  /** Custom dash sequence (`dash, gap, dash, gap…` syntax). Wins over the dash/gap pair. */
  strokeDashPattern?: number[];
  /** Cap drawn on each dash segment. */
  strokeDashCap?: "butt" | "round" | "square";
  /** "Miter angle": joins sharper than this bevel instead of pointing. */
  strokeMiterAngle?: number;
  aspectLocked: boolean;
  /** The ratio the lock was taken at (height ÷ width), remembered so a size
   *  that clamps to a pixel on the way to a new one cannot leave a locked box
   *  square. Written when the lock is turned on; a locked resize keeps it up to
   *  date. */
  aspectRatio?: number;
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
   *  text layer following its content, ) stops overriding it. */
  nameLocked?: boolean;
  /** Sizing constraints (min/max width & height) */
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  /** Absolute position inside auto-layout frame */
  absolutePosition?: boolean;
  /* ── Inside a grid ──────────────────────────────────────────────────────
   * "Column span" / "Row span": how many cells the object stretches across.
   * `gridCol`/`gridRow` are where it sits, written by the engine while
   * automatic positioning is on and read back when it is switched off, so
   * turning the setting off keeps the arrangement the objects already have. */
  colSpan?: number;
  rowSpan?: number;
  gridCol?: number;
  gridRow?: number;
  /** A cell this object was placed into on purpose - the frame tool clicked
   *  into one. Automatic positioning keeps it there and flows the rest of the
   *  objects around it, which is also what puts `⌘D` in the next cell: the
   *  copy sits directly above its original, so the flow picks up after it. */
  gridPinned?: boolean;
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
  textWrap: TextWrap;
  listStyle: ListStyle;
  /** First-line offset of every paragraph, in points (x-core's paragraph_indent). */
  paragraphIndent: number;
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
  /** Frame layout grids (columns, rows, grid) */
  layoutGrids?: LayoutGrid[];
  /** Ellipse arc / donut properties */
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
  /** Separates the visual grid from "Snap to pixel grid", which is the
   *  behaviour (whole-pixel coordinates while moving/resizing). Optional so
   *  documents written before the split keep loading; the default is on. */
  pixelSnap?: boolean;
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
  /** View > Prototype flows. When off the canvas hides connection
   *  noodles and hotspot handles, which is what makes Design mode look like
   *  Design mode. */
  showFlows: boolean;
  /** View > Rulers (⇧R). */
  showRulers: boolean;
  /** View > Minimap. Off by default; it costs its own render pass. */
  showMinimap: boolean;
  /** "Pixel preview" in the Zoom/view options menu: vectors drawn as
   *  the raster they would export as, at 1x or 2x device pixels. */
  pixelPreview: PixelPreview;
  /** "Layout guides" in the same menu: one switch to hide every
   *  frame's layout grid without deleting any of them. */
  viewLayoutGuides: boolean;
  /** "Property labels": names beside the icon-only controls in the
   *  right sidebar, for someone still learning what each one does. */
  propertyLabels: boolean;
  /** Comment pins are hidden unless the comment tool is active or the user
   *  has explicitly turned them on, by default. */
  showComments: boolean;
  /** View > Outlines (⇧O / ⌘Y): wireframe mode showing object outlines without fills. */
  outlineMode?: boolean;
  /** Thread whose popover is open, if any. */
  openComment: string;
  /** Variables / Tokens store */
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

/** Off, or the density a rasterised preview is drawn at. */
export type PixelPreview = "off" | "1x" | "2x";

export type Command =
  | { type: "select"; ids: string[] }
  | { type: "setTool"; tool: Tool }
  | { type: "setZoom"; zoom: number; anchorX?: number; anchorY?: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "setPan"; x: number; y: number }
  | { type: "setRightTab"; tab: RightTab }
  | { type: "toggleRulers" }
  | { type: "setPixelPreview"; preview: PixelPreview }
  | { type: "toggleLayoutGuides" }
  | { type: "togglePropertyLabels" }
  | { type: "toggleMinimap" }
  | { type: "toggleFlows"; enabled?: boolean }
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
  // "Auto layout is only supported on frames. If you have one or more layers
  // selected, an auto layout frame wraps them." Selecting a
  // frame sets the layout on it; anything else - a plain layer, a group, a
  // multi-selection - is wrapped in a new frame that gets the layout.
  | { type: "wrapAutoLayout"; ids: string[]; layout: AutoLayout }
  // "Remove all auto layout": the frame and everything nested inside it.
  | { type: "removeAllLayout"; id: string }
  | { type: "nudge"; dx: number; dy: number }
  | { type: "begin" }
  | { type: "end" }
  | { type: "cut" }
  | { type: "copy" }
  | { type: "paste"; x?: number; y?: number; inPlace?: boolean }
  /** Replace the in-app clipboard with layers that came from outside this
   *  document — the system clipboard's own payload, so a copy made in another
   *  tab or another file pastes with full fidelity. Not a document edit, so it
   *  takes no undo step; the `paste` that follows does. */
  | { type: "loadClip"; nodes: XNode[] }
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
  | { type: "patchPage"; patch: Partial<Pick<Page, "pixelGrid" | "pixelGridColor" | "pixelSnap" | "name" | "flowStart">> }
  | { type: "distribute"; axis: "h" | "v" }
  | { type: "tidyUp"; axis?: "auto" | "h" | "v" }
  | { type: "swapFillStroke" }
  | { type: "toggleStroke" }
  | { type: "toggleOutlines" }
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
  | { type: "flatten"; id?: string }
  | { type: "outlineStroke"; id?: string }
  | { type: "offsetPath"; id?: string; distance: number; join?: StrokeJoin }
  | { type: "simplifyPath"; id?: string; tolerance?: number }
  | { type: "convertTextToVector"; id?: string }
  | { type: "shapeBuilder"; op: "merge" | "subtract" }
  | { type: "vectorAlign"; alignment: "left" | "center" | "right" | "top" | "middle" | "bottom" }
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
