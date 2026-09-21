/**
 * Document types that mirror `x-core::Node` / `.x` JSON enough for the
 * designer chrome. The native app remains the GPU owner; this is the
 * command-API view a WASM `x-editor` can implement later.
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
  | "star";

export type Overflow = "visible" | "clip" | "scrollx" | "scrolly" | "scrollboth";
export type Sizing = "fixed" | "hug";
export type LayoutDirection = "horizontal" | "vertical";
export type TextAlign = "left" | "center" | "right" | "justified";
export type TextAlignVertical = "top" | "middle" | "bottom";
export type RightTab = "design" | "prototype" | "inspect";
export type LeftTab = "layers" | "assets" | "tokens";

export type Tool =
  | "select"
  | "scale"
  | "frame"
  | "slice"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "poly"
  | "star"
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
  strokePaint: string;
  strokeWidth: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  overflow: Overflow;
  cornerRadii: [number, number, number, number];
  text: string;
  fontSize: number;
  fontWeight: number;
  textAlign: TextAlign;
  textAlignVertical: TextAlignVertical;
  children: XNode[];
  layout: AutoLayout | null;
}

export interface Page {
  id: string;
  name: string;
  root: XNode;
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
}

export type Command =
  | { type: "select"; ids: string[] }
  | { type: "setTool"; tool: Tool }
  | { type: "setZoom"; zoom: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "setPan"; x: number; y: number }
  | { type: "setRightTab"; tab: RightTab }
  | { type: "setLeftTab"; tab: LeftTab }
  | { type: "setPage"; index: number }
  | { type: "addPage" }
  | {
      type: "add";
      kind: NodeKind;
      x: number;
      y: number;
      w: number;
      h: number;
      parent?: string;
    }
  | { type: "move"; ids: string[]; dx: number; dy: number }
  | { type: "resize"; id: string; x: number; y: number; w: number; h: number }
  | { type: "delete" }
  | { type: "duplicate" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "patch"; id: string; patch: Partial<XNode> }
  | { type: "autoLayout"; id: string; layout: AutoLayout | null }
  | { type: "nudge"; dx: number; dy: number }
  | { type: "begin" }
  | { type: "end" };

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
  { id: "slice", label: "Slice", shortcut: "S" },
  { id: "text", label: "Text", shortcut: "T" },
  { id: "rect", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "line", label: "Line", shortcut: "L" },
  { id: "arrow", label: "Arrow", shortcut: "⇧L" },
  { id: "poly", label: "Polygon", shortcut: "" },
  { id: "star", label: "Star", shortcut: "" },
  { id: "pen", label: "Pen", shortcut: "P" },
  { id: "pencil", label: "Pencil", shortcut: "⇧P" },
  { id: "brush", label: "Brush", shortcut: "B" },
  { id: "eraser", label: "Eraser", shortcut: "⇧E" },
  { id: "comment", label: "Comment", shortcut: "C" },
  { id: "hand", label: "Hand", shortcut: "H" },
];
