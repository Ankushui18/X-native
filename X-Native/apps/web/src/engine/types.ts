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
export type LayoutAlign = "min" | "center" | "max";
export type LayoutJustify = "min" | "center" | "max" | "between";
export type TextAlign = "left" | "center" | "right" | "justified";
export type TextAlignVertical = "top" | "middle" | "bottom";
export type TextDecoration = "none" | "underline" | "strikethrough";
export type TextCase = "none" | "upper" | "lower" | "title" | "small-caps";
export type StrokeAlign = "inside" | "center" | "outside";
export type StrokeCap = "none" | "round" | "square" | "arrow";
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
  | "glass";
export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";
export type ProtoTrigger = "onClick" | "onHover" | "afterDelay";
export type ProtoAction = "navigate" | "back" | "openUrl";
export type ProtoAnim = "instant" | "dissolve" | "smart";

export interface PathPoint {
  x: number;
  y: number;
  /** Incoming bezier handle, relative to the point (Figma pen). */
  ix?: number;
  iy?: number;
  /** Outgoing bezier handle, relative to the point. */
  ox?: number;
  oy?: number;
}

export interface Interaction {
  trigger: ProtoTrigger;
  action: ProtoAction;
  destination: string;
  animation: ProtoAnim;
  delay: number;
}

export interface ComponentVariant {
  name: string;
  node: XNode;
}

export interface ComponentMaster {
  id: string;
  name: string;
  node: XNode;
  variants: ComponentVariant[];
  property: string;
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
}

export interface Page {
  id: string;
  name: string;
  root: XNode;
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
  presentFrame: string;
  presentStack: string[];
  /** Figma's View > Rulers (⇧R). */
  showRulers: boolean;
}

export type Command =
  | { type: "select"; ids: string[] }
  | { type: "setTool"; tool: Tool }
  | { type: "setZoom"; zoom: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "setPan"; x: number; y: number }
  | { type: "setRightTab"; tab: RightTab }
  | { type: "toggleRulers" }
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
  | { type: "flip"; axis: "h" | "v" }
  | { type: "duplicatePage" }
  | { type: "deletePage" }
  | { type: "renamePage"; name: string }
  | { type: "patchPage"; patch: Partial<Pick<Page, "pixelGrid" | "pixelGridColor" | "name" | "flowStart">> }
  | { type: "distribute"; axis: "h" | "v" }
  | { type: "boolean"; op: BooleanOp }
  | { type: "makeComponent" }
  | { type: "detachInstance" }
  | { type: "placeComponent"; id: string; x: number; y: number }
  | { type: "addPath"; points: PathPoint[]; closed: boolean }
  | { type: "patchPath"; id: string; path: PathPoint[]; closed?: boolean }
  | { type: "flatten" }
  | { type: "outlineStroke" }
  | { type: "addVariant"; name: string }
  | { type: "setVariant"; id: string; name: string }
  | { type: "setInteractions"; id: string; interactions: Interaction[] }
  | { type: "presentStart"; id?: string }
  | { type: "presentGo"; id: string }
  | { type: "presentBack" }
  | { type: "presentStop" };

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
