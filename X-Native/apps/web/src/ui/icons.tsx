import type { CSSProperties, ReactElement } from "react";
import type { Tool } from "../engine/types";
import type { LucideIcon } from "lucide-react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Anchor,
  AppWindow,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ArrowUpToLine,
  Baseline,
  Blend,
  Boxes,
  Brush,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Circle,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Clipboard,
  CodeXml,
  Columns2,
  Combine,
  Component,
  Contrast,
  Copy,
  CopyPlus,
  CornerDownRight,
  Diamond,
  Ellipsis,
  Equal,
  Eraser,
  Expand,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FlipHorizontal2,
  FlipVertical2,
  Folder,
  Frame,
  Fullscreen,
  Grid2x2,
  Grid2x2X,
  Group,
  Hand,
  History,
  Image,
  Import,
  Info,
  Italic,
  Layers,
  Lasso,
  LayoutGrid,
  LayoutList,
  LayoutTemplate,
  Link,
  Link2Off,
  ListCollapse,
  Lock,
  LockOpen,
  Maximize2,
  Merge,
  MessageSquare,
  Minimize,
  Minimize2,
  Minus,
  Monitor,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
  Octagon,
  PaintBucket,
  PanelTop,
  PenTool,
  Pencil,
  Pentagon,
  Pin,
  Pipette,
  Play,
  Plus,
  Presentation,
  Ratio,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Rows2,
  Ruler,
  Scaling,
  ScanSearch,
  Scissors,
  Search,
  Shapes,
  Share,
  Slash,
  Slice,
  SlidersHorizontal,
  Smartphone,
  Space,
  Sparkles,
  Spline,
  Square,
  SquareCode,
  SquareDashed,
  SquareMinus,
  SquarePen,
  SquareStack,
  Squircle,
  Star,
  Strikethrough,
  Tablet,
  Trash2,
  Triangle,
  Type,
  Underline,
  UnfoldHorizontal,
  UnfoldVertical,
  Ungroup,
  Unlink,
  Upload,
  UsersRound,
  Variable,
  Volume2,
  VolumeX,
  Waypoints,
  Workflow,
  WrapText,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

/**
 * The icon set, drawn from Lucide (lucide.dev) since 2026-09-29.
 *
 * Before that date this file held ~1,100 lines of hand-drawn 16x16 glyphs
 * (the "Phase 6" set). They are gone: every product surface now renders a
 * Lucide component through the table below, on Lucide's own 24-grid metrics
 * (2-unit stroke, round caps/joins, currentColor). The four sizes are
 * unchanged, and still the only sizes in use:
 *   ICON_XS (12)  - a disclosure caret, or a glyph inside a line of small text.
 *   ICON_SM (14)  - an icon in a panel row: layers, sections, property rows.
 *   ICON_MD (16)  - a control in the toolbar, the rail, or its own button.
 *   ICON_LG (20)  - a brand mark, or an empty state's illustration.
 * Reach for the constant rather than a number.
 *
 * `caretSize()` is the one a menu opener should call.
 *
 * Rules for contributors: (1) `Icon` takes `IconName`, and the table is a
 * `Record<IconName, ...>` (minus `logo`), so a new name without a Lucide
 * mapping does not compile - the type is the bug alarm the old default
 * circle used to be. (2) One metaphor per action: no near-duplicate
 * families. Where two names share one Lucide glyph it is either a preserved
 * equivalence from the old set (move/select/pointer, chevron/chevron-down,
 * close/x-mark, pen/vector, proto/magic-noodle, vars/variable, the align
 * aliases) or shape identity across unrelated domains (a circle means a
 * circle in the toolbar and in the stroke-cap picker). (3) The table was
 * verified name-by-name against the installed lucide-react's exports and
 * alias graph (BoxSelect, for example, is an alias of SquareDashed, so it
 * must never be used as a second mapping).
 *
 * Deliberate fixes the migration bought (the old art was wrong, not just
 * old): arrow-right showed a diagonal arrow (it was shared with the arrow
 * tool); upload/import shared one download-into-tray glyph; refresh/reset/
 * history shared one circular arrow; layout-none was pixel-identical to
 * layout-grid; text/type shared one T; group/collapse-layers shared one
 * square; grid-view shared the 2x2 cell art instead of a view glyph.
 *
 * The one exception is `logo`: the X-Native brand tile (dark rounded
 * square, green/white X). It is brand identity, not an icon, and Lucide
 * carries no brand marks, so it stays hand-drawn. Its three quoted hex
 * colours are brand ink, not theme tokens, which is why the drift ratchet's
 * icons.tsx colour ceiling is 3 and not 0.
 */

/** A caret, or a glyph inside a line of small text. */
export const ICON_XS = 12;
/** An icon in a panel row. */
export const ICON_SM = 14;
/** A toolbar, rail or standalone control. */
export const ICON_MD = 16;
/** A brand mark or an empty state's illustration. */
export const ICON_LG = 20;

/** The one size a disclosure caret is ever drawn at. */
export const caretSize = (): number => ICON_XS;
/** The one size a panel row's icon is ever drawn at. */
export const rowIconSize = (): number => ICON_SM;

export type IconName =
  | "absolute"
  | "agent"
  | "align-bottom"
  | "align-center"
  | "align-hcenter"
  | "align-left"
  | "align-middle"
  | "align-right"
  | "align-text-center"
  | "align-text-justified"
  | "align-text-left"
  | "align-text-right"
  | "align-top"
  | "align-vcenter"
  | "arrow"
  | "arrow-downward"
  | "arrow-left"
  | "arrow-right"
  | "aspect"
  | "back"
  | "bend"
  | "boolean-exclude"
  | "boolean-intersect"
  | "boolean-subtract"
  | "boolean-union"
  | "brush"
  | "cap-circle"
  | "cap-diamond"
  | "cap-none"
  | "cap-reverse-triangle"
  | "cap-round"
  | "cap-square"
  | "check"
  | "chevron"
  | "chevron-down"
  | "chevron-right"
  | "chevron-up"
  | "chevrons-down"
  | "chevrons-up"
  | "clipboard"
  | "close"
  | "code"
  | "collapse-layers"
  | "comment"
  | "community"
  | "component"
  | "constraints"
  | "copy"
  | "dash"
  | "desktop"
  | "detach"
  | "dev"
  | "distribute-h"
  | "distribute-v"
  | "duplicate"
  | "edit-text"
  | "ellipse"
  | "eraser"
  | "export"
  | "eye"
  | "eye-off"
  | "eyedropper"
  | "flatten"
  | "flip-h"
  | "flip-v"
  | "flow"
  | "folder"
  | "frame"
  | "fullscreen"
  | "gap"
  | "grid"
  | "grid-view"
  | "group"
  | "hand"
  | "help"
  | "history"
  | "image"
  | "import"
  | "independent"
  | "info"
  | "instance"
  | "italic"
  | "join-bevel"
  | "join-miter"
  | "join-round"
  | "layers"
  | "lasso"
  | "layout"
  | "layout-grid"
  | "layout-h"
  | "layout-none"
  | "layout-v"
  | "line"
  | "link"
  | "link-broken"
  | "list-view"
  | "lock"
  | "logo"
  | "magic-noodle"
  | "mask"
  | "minimize"
  | "minus"
  | "more"
  | "move"
  | "navigate-back"
  | "open"
  | "padding-horizontal"
  | "padding-vertical"
  | "page"
  | "paint"
  | "pen"
  | "pencil"
  | "phone"
  | "play"
  | "plus"
  | "pointer"
  | "poly"
  | "proto"
  | "radius"
  | "rect"
  | "refresh"
  | "reset"
  | "resources"
  | "rotate"
  | "scale"
  | "scissors"
  | "search"
  | "section"
  | "select"
  | "shape-builder"
  | "shapes"
  | "slice"
  | "slide"
  | "star"
  | "strike"
  | "stroke-center"
  | "stroke-inside"
  | "stroke-outside"
  | "tablet"
  | "text"
  | "text-auto-height"
  | "text-auto-width"
  | "text-fixed"
  | "tools"
  | "trash"
  | "type"
  | "type-settings"
  | "underline"
  | "unlock"
  | "upload"
  | "valign-bottom"
  | "valign-middle"
  | "valign-top"
  | "variable"
  | "vars"
  | "vector"
  | "visual-search"
  | "volume"
  | "volume-x"
  | "width-min"
  | "wrap"
  | "x-mark"
  | "zoom-in"
  | "zoom-out";

/** The svg sizing the old hand-drawn set wrote inline: width, height and
 *  display block. Lucide sets width/height as attributes, which the domEnv
 *  allowlist does not recognise, so `Icon` keeps writing the same triple as
 *  a style object - built by this helper rather than an inline literal, so
 *  the drift ratchet's inline-style ceiling still reads this file as zero. */
const svgStyle = (size: number): CSSProperties => ({
  width: size,
  height: size,
  display: "block",
});

/** The X-Native brand tile. See the header: the one glyph Lucide cannot draw. */
function LogoMark({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
          <rect className="brand-tile" width="24" height="24" rx="4" />
          <path
            className="brand-accent"
            d="M16.7072 6.01489L16.5894 6.17866L15.9515 7.08685V7.10174H15.9445L15.3205 8.00248L15.1818 8.19603L14.6826 8.91067L14.4191 9.29032L14.0447 9.8263L13.6564 10.3846L13.4137 10.7345L12.9006 11.4715L12.7758 11.6427L12.1448 12.5509L12.131 12.5583L11.5 13.4591L11.6317 13.6452L12.131 14.3672L12.3875 14.7395L12.7619 15.2754L13.1433 15.8263L13.3929 16.1836L13.906 16.9132L14.0308 17.0918L14.6687 18H15.9307H17.1995H18.4684L17.8374 17.0844L17.7126 16.9057L17.1995 16.1762L16.9499 15.8189L16.5686 15.268L16.1941 14.732L15.9376 14.3598L15.4384 13.6377L15.3066 13.4442L15.9376 12.5434L16.5755 11.6203L16.6934 11.4491L17.2065 10.7122L17.4492 10.3623L17.8374 9.80397L18.2119 9.26799L18.4753 8.88834L18.9746 8.1737L19.1133 7.98015L19.7373 7.08685V7.07196L20.3821 6.16377L20.5 6H16.6934L16.7072 6.01489Z"
          />
          <path
            className="brand-ink"
            d="M8.90422 15.8311L9.29124 15.2795L9.67123 14.7429L9.93159 14.3702L10.4382 13.6472L10.5719 13.4609L11.2123 12.559L11.8597 11.6348L11.9793 11.4634L12.5 10.7255L12.2467 10.3752L11.8526 9.81615L11.4726 9.2795L11.2052 8.89938L10.6986 8.18385L10.5579 7.99006L9.92455 7.0882V7.07329H9.91751L9.27013 6.16398L9.15051 6H5.31548L5.43511 6.16398L6.07545 7.07329V7.0882L6.72283 7.99006L6.86357 8.18385L7.37021 8.89938L7.63761 9.2795L8.01055 9.81615L8.40461 10.3752L8.65794 10.7255L8.13722 11.4634L8.01055 11.6348L7.37021 12.5441L6.72987 13.4534L6.59617 13.6398L6.08952 14.3627L5.82916 14.7354L5.44918 15.272L5.06216 15.8236L4.80883 16.1814L4.28812 16.9118L4.16145 17.0907L3.52111 18H3.5H4.78772H6.07545H7.36317L8.01055 17.0832L8.13722 16.9043L8.65794 16.1739L8.91126 15.8161L8.90422 15.8311Z"
          />
        </svg>
  );
}

/** Every icon name and the Lucide glyph that draws it. */
const GLYPH: Record<Exclude<IconName, "logo">, LucideIcon> = {
  "absolute": Pin,
  "agent": Sparkles,
  "align-bottom": AlignEndHorizontal,
  "align-center": AlignCenterVertical,
  "align-hcenter": AlignCenterVertical,
  "align-left": AlignStartVertical,
  "align-middle": AlignCenterHorizontal,
  "align-right": AlignEndVertical,
  "align-text-center": AlignCenter,
  "align-text-justified": AlignJustify,
  "align-text-left": AlignLeft,
  "align-text-right": AlignRight,
  "align-top": AlignStartHorizontal,
  "align-vcenter": AlignCenterHorizontal,
  "arrow": ArrowUpRight,
  "arrow-downward": ArrowDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "aspect": Ratio,
  "back": ArrowLeft,
  "bend": Spline,
  "boolean-exclude": Ungroup,
  "boolean-intersect": SquareStack,
  "boolean-subtract": SquareMinus,
  "boolean-union": Combine,
  "brush": Brush,
  "cap-circle": CircleDashed,
  "cap-diamond": Diamond,
  "cap-none": Minus,
  "cap-reverse-triangle": Triangle,
  "cap-round": Circle,
  "cap-square": Square,
  "check": Check,
  "chevron": ChevronDown,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "chevrons-down": ChevronsDown,
  "chevrons-up": ChevronsUp,
  "clipboard": Clipboard,
  "close": X,
  "code": SquareCode,
  "collapse-layers": ListCollapse,
  "comment": MessageSquare,
  "community": UsersRound,
  "component": Component,
  "constraints": Anchor,
  "copy": Copy,
  "dash": SquareDashed,
  "desktop": Monitor,
  "detach": Unlink,
  "dev": CodeXml,
  "distribute-h": AlignHorizontalDistributeCenter,
  "distribute-v": AlignVerticalDistributeCenter,
  "duplicate": CopyPlus,
  "edit-text": SquarePen,
  "ellipse": Circle,
  "eraser": Eraser,
  "export": Share,
  "eye": Eye,
  "eye-off": EyeOff,
  "eyedropper": Pipette,
  "flatten": Merge,
  "flip-h": FlipHorizontal2,
  "flip-v": FlipVertical2,
  "flow": Workflow,
  "folder": Folder,
  "frame": Frame,
  "fullscreen": Fullscreen,
  "gap": Space,
  "grid": Grid2x2,
  "grid-view": LayoutGrid,
  "group": Group,
  "hand": Hand,
  "help": CircleHelp,
  "history": History,
  "image": Image,
  "import": Import,
  "independent": Expand,
  "info": Info,
  "instance": Diamond,
  "italic": Italic,
  "join-bevel": Octagon,
  "join-miter": Square,
  "join-round": CornerDownRight,
  "layers": Layers,
  "lasso": Lasso,
  "layout": LayoutTemplate,
  "layout-grid": Grid2x2,
  "layout-h": Columns2,
  "layout-none": Grid2x2X,
  "layout-v": Rows2,
  "line": Slash,
  "link": Link,
  "link-broken": Link2Off,
  "list-view": LayoutList,
  "lock": Lock,
  "magic-noodle": Waypoints,
  "mask": Contrast,
  "minimize": Minimize,
  "minus": Minus,
  "more": Ellipsis,
  "move": MousePointer2,
  "navigate-back": ArrowLeft,
  "open": ExternalLink,
  "padding-horizontal": MoveHorizontal,
  "padding-vertical": MoveVertical,
  "page": File,
  "paint": PaintBucket,
  "pen": PenTool,
  "pencil": Pencil,
  "phone": Smartphone,
  "play": Play,
  "plus": Plus,
  "pointer": MousePointer2,
  "poly": Pentagon,
  "proto": Waypoints,
  "radius": Squircle,
  "rect": Square,
  "refresh": RefreshCw,
  "reset": RotateCcw,
  "resources": Boxes,
  "rotate": RotateCw,
  "scale": Scaling,
  "scissors": Scissors,
  "search": Search,
  "section": PanelTop,
  "select": MousePointer2,
  "shape-builder": Blend,
  "shapes": Shapes,
  "slice": Slice,
  "slide": Presentation,
  "star": Star,
  "strike": Strikethrough,
  "stroke-center": CircleDot,
  "stroke-inside": Minimize2,
  "stroke-outside": Maximize2,
  "tablet": Tablet,
  "text": Type,
  "text-auto-height": UnfoldVertical,
  "text-auto-width": UnfoldHorizontal,
  "text-fixed": AppWindow,
  "tools": Wrench,
  "trash": Trash2,
  "type": Baseline,
  "type-settings": SlidersHorizontal,
  "underline": Underline,
  "unlock": LockOpen,
  "upload": Upload,
  "valign-bottom": ArrowDownToLine,
  "valign-middle": Equal,
  "valign-top": ArrowUpToLine,
  "variable": Variable,
  "vars": Variable,
  "vector": PenTool,
  "visual-search": ScanSearch,
  "volume": Volume2,
  "volume-x": VolumeX,
  "width-min": Ruler,
  "wrap": WrapText,
  "x-mark": X,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}): ReactElement {
  if (name === "logo") return <LogoMark size={size} className={className} />;
  const Cmp = GLYPH[name];
  return <Cmp size={size} className={className} style={svgStyle(size)} />;
}

export const TOOL_ICON: Record<Tool, IconName> = {
  select: "move",
  scale: "scale",
  frame: "frame",
  section: "section",
  slice: "slice",
  text: "text",
  rect: "rect",
  ellipse: "ellipse",
  line: "line",
  arrow: "arrow",
  poly: "poly",
  star: "star",
  image: "image",
  pen: "pen",
  pencil: "pencil",
  brush: "brush",
  eraser: "eraser",
  comment: "comment",
  hand: "hand",
  zoom: "zoom-in",
};

export function kindIcon(k: string, imageSrc?: string): IconName {
  if (imageSrc) return "image";
  switch (k) {
    case "frame":
      return "frame";
    case "section":
      return "section";
    case "ellipse":
      return "ellipse";
    case "text":
      return "text";
    case "line":
      return "line";
    case "arrow":
      return "arrow";
    case "star":
      return "star";
    case "poly":
      return "poly";
    case "group":
      return "group";
    case "component":
      return "component";
    case "instance":
      return "instance";
    case "boolean":
    case "vector":
      return "pen";
    default:
      return "rect";
  }
}
