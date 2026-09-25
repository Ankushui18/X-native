import type { CSSProperties, ReactElement, SVGProps } from "react";
import type { Tool } from "../engine/types";

/**
 * 16×16 X-Native icon specification:
 * Sourced from X-Native design language — adapted from 16×16 grid systems.
 * Standard: 16×16 grid, 1.25px stroke, round caps/joins, currentColor for crisp rendering at 14–16px.
 *
 * Four sizes are used on purpose, and nothing else:
 *   ICON_XS (12)  - a disclosure caret, or a glyph inside a line of small text.
 *   ICON_SM (14)  - an icon in a panel row: layers, sections, property rows.
 *   ICON_MD (16)  - a control in the toolbar, the rail, or its own button.
 *   ICON_LG (20)  - a brand mark, or an empty state's illustration.
 * Reach for the constant rather than a number. Before this the call sites
 * picked their own: 9, 10, 11, 12, 13, 14, 16, 20, 22 and 28 all appeared, so
 * the same chevron was drawn at four different weights - and at 9px the
 * chevron's 1.4-unit stroke rendered at 0.79px, which reads as a different
 * icon rather than a smaller one.
 *
 * `caretSize()` is the one a menu opener should call.
 */
const S: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

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

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}): ReactElement {
  const style: CSSProperties = { width: size, height: size, display: "block" };
  const p = { ...S, className, style };

  switch (name) {
    // -------------------------------------------------------------------------
    // Selection & Navigation Tools
    // -------------------------------------------------------------------------
    case "move":
    case "select":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M3 2v11.5l3.2-3 2.3 4.5 1.7-.8-2.3-4.4 4.5-.2z" />
        </svg>
      );
    case "scale":
    case "resize":
    case "resize-alt":
      return (
        <svg {...p}>
          <path d="M5.5 2.5H2.5v3M10.5 13.5h3v-3M3 3l4.5 4.5M13 13l-4.5-4.5" />
        </svg>
      );
    case "hand":
      return (
        <svg {...p}>
          <path d="M5.5 7V4.5a1 1 0 012 0V7M8 6.5V3.5a1 1 0 012 0v3.5M10.5 7V4.5a1 1 0 012 0v5a4 4 0 01-4 4h-.5a3.8 3.8 0 01-3.8-3.8V8a1 1 0 012 0v.5" />
        </svg>
      );
    case "search":
    case "visual-search":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="4" />
          <path d="M13 13l-3.2-3.2" strokeWidth={1.3} />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="4" />
          <path d="M13 13l-3.2-3.2M7 5v4M5 7h4" strokeWidth={1.25} />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="4" />
          <path d="M13 13l-3.2-3.2M5 7h4" strokeWidth={1.25} />
        </svg>
      );
    case "actual-size":
    case "zoom-no":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
          <path d="M6 5.5v5M9.5 5.5v5M5.5 6L6 5.5M9 6l.5-.5" />
        </svg>
      );
    case "fit-screen":
    case "fit-width":
    case "fit-height":
    case "fill-screen":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
          <path d="M5.5 2.5v11M10.5 2.5v11" />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Creation & Canvas Containers
    // -------------------------------------------------------------------------
    case "frame":
    case "hash":
      return (
        <svg {...p}>
          <path d="M5.5 1.5v13M10.5 1.5v13M1.5 5.5h13M1.5 10.5h13" strokeWidth={1.25} />
        </svg>
      );
    case "section":
      return (
        <svg {...p}>
          <rect x="2.5" y="4.5" width="11" height="9" rx="1.5" />
          <path d="M2.5 7.5h11M5.5 4.5V3h5v1.5" />
        </svg>
      );
    case "slice":
      return (
        <svg {...p} strokeDasharray="2 1.5">
          <rect x="2.5" y="2.5" width="11" height="11" rx="0.5" />
        </svg>
      );
    case "rect":
    case "square":
    case "shapes":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeWidth={1.25} />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.25} />
        </svg>
      );
    case "line":
      return (
        <svg {...p}>
          <path d="M2.5 13.5L13.5 2.5" strokeWidth={1.25} />
        </svg>
      );
    case "arrow":
    case "arrow-right":
      return (
        <svg {...p}>
          <path d="M3.5 12.5L12.5 3.5M7 3.5h5.5V9" strokeWidth={1.25} />
        </svg>
      );
    case "arrow-downward":
      return (
        <svg {...p}>
          <path d="M8 2.5v11M3.5 9L8 13.5 12.5 9" strokeWidth={1.25} />
        </svg>
      );
    case "poly":
    case "polygon":
      return (
        <svg {...p}>
          <path d="M8 2.5l5.5 10.5H2.5L8 2.5z" strokeWidth={1.25} />
        </svg>
      );
    case "star":
    case "count-star":
      return (
        <svg {...p}>
          <path d="M8 2.2l1.7 3.8 4.1.3-3.1 2.8.9 4.1L8 11.2l-3.6 2 1-4.1-3.2-2.8 4.2-.3z" strokeWidth={1.25} />
        </svg>
      );
    case "image":
    case "images":
    case "fill-image":
      return (
        <svg {...p}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" strokeWidth={1.25} />
          <circle cx="5.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
          <path d="M2.8 11.2l3.4-3.2 2.3 2.1 2.3-2.3 2.4 2.8" strokeWidth={1.2} />
        </svg>
      );
    case "pen":
    case "vector":
    case "vector-bend":
      return (
        <svg {...p}>
          <path d="M10 2.5l3.5 3.5-7.5 7.5H2.5v-3.5zM8.5 4l3.5 3.5M2.5 13.5l3-3" strokeWidth={1.25} />
          <circle cx="7" cy="9" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...p}>
          <path d="M11 2.5l2.5 2.5-8 8H3v-2.5zM9.5 4l2.5 2.5" strokeWidth={1.25} />
        </svg>
      );
    case "brush":
      return (
        <svg {...p}>
          <path d="M11.5 2.5l2 2-4.5 4.5-2-2zM7 7l-2 2c-1.2 1.2-1.5 2.8-1.5 3.8 1 0 2.6-.3 3.8-1.5l2-2" strokeWidth={1.25} />
        </svg>
      );
    case "eraser":
      return (
        <svg {...p}>
          <path d="M5.5 13.5L2.5 10.5a1.5 1.5 0 010-2.1l6-6a1.5 1.5 0 012.1 0l3 3a1.5 1.5 0 010 2.1l-6 6H5.5zM6 5.5l4.5 4.5" strokeWidth={1.25} />
        </svg>
      );
    case "text":
    case "edit-text":
    case "shape-text":
      return (
        <svg {...p}>
          <path d="M3 3.5h10M8 3.5v9.5M5.5 13h5" strokeWidth={1.3} />
        </svg>
      );
    case "comment":
    case "notes":
      return (
        <svg {...p}>
          <path d="M3 3.5h10a1.5 1.5 0 011.5 1.5v5a1.5 1.5 0 01-1.5 1.5H7.5L3.5 14v-2.5H3A1.5 1.5 0 011.5 10V5A1.5 1.5 0 013 3.5z" strokeWidth={1.25} />
        </svg>
      );
    case "figma":
      return (
        <svg width={size} height={size} viewBox="0 0 38 57" fill="none">
          <path d="M19 28.5A9.5 9.5 0 1 1 28.5 19 9.5 9.5 0 0 1 19 28.5z" fill="#1abcfe" />
          <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5A9.5 9.5 0 0 1 9.5 57 9.5 9.5 0 0 1 0 47.5z" fill="#0acf83" />
          <path d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19z" fill="#ff7262" />
          <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#f24e1e" />
          <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#a259ff" />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Components, Variants & Instances
    // -------------------------------------------------------------------------
    case "component":
      // X-Native 4-diamond master component icon
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M8 2.2l2 2-2 2-2-2zM12.3 6.5l2 2-2 2-2-2zM8 10.8l2 2-2 2-2-2zM3.7 6.5l2 2-2 2-2-2z" />
        </svg>
      );
    case "instance":
      // X-Native single outlined diamond
      return (
        <svg {...p}>
          <polygon points="8,2.2 13.8,8 8,13.8 2.2,8" strokeWidth={1.25} />
        </svg>
      );
    case "component-set":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeDasharray="2 1.5" />
          <polygon points="8,4.5 11.5,8 8,11.5 4.5,8" fill="currentColor" stroke="none" />
        </svg>
      );
    case "variant":
    case "create-variant":
      return (
        <svg {...p}>
          <polygon points="7,2.2 12.5,7.7 7,13.2 1.5,7.7" strokeWidth={1.2} />
          <path d="M12.5 10.5v4M10.5 12.5h4" strokeWidth={1.25} />
        </svg>
      );
    case "instance-swap":
    case "swap":
      return (
        <svg {...p}>
          <polygon points="8,4.5 11.5,8 8,11.5 4.5,8" strokeWidth={1.1} />
          <path d="M3 3h4M3 3l2-2M13 13h-4M13 13l-2 2" strokeWidth={1.2} />
        </svg>
      );
    case "detach":
      return (
        <svg {...p}>
          <path d="M7 9l2-2M9 4.5a2.5 2.5 0 013.5 3.5L11 9.5M7 6.5L5.5 8a2.5 2.5 0 003.5 3.5L10.5 10" strokeWidth={1.25} />
        </svg>
      );
    case "reset":
    case "refresh":
    case "restart":
      return (
        <svg {...p}>
          <path d="M3.5 8a4.5 4.5 0 101.3-3.2L3 6.5M3 3v3.5h3.5" strokeWidth={1.25} />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Auto Layout & Sizing
    // -------------------------------------------------------------------------
    case "layout-h":
    case "add-horizontal":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="4" height="10" rx="1.2" strokeWidth={1.25} />
          <rect x="9" y="3" width="4" height="10" rx="1.2" strokeWidth={1.25} />
        </svg>
      );
    case "layout-v":
    case "add-vertical":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="4" rx="1.2" strokeWidth={1.25} />
          <rect x="3" y="9" width="10" height="4" rx="1.2" strokeWidth={1.25} />
        </svg>
      );
    case "wrap":
    case "add-wrap":
      return (
        <svg {...p}>
          <rect x="2.5" y="3" width="4.5" height="4" rx="1" strokeWidth={1.2} />
          <rect x="9" y="3" width="4.5" height="4" rx="1" strokeWidth={1.2} />
          <rect x="2.5" y="9" width="4.5" height="4" rx="1" strokeWidth={1.2} />
          <path d="M12.5 9v1.5a1.5 1.5 0 01-1.5 1.5H9m0 0l1.5-1.5M9 12l1.5 1.5" strokeWidth={1.2} />
        </svg>
      );
    case "layout-none":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
          <rect x="9" y="9" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
        </svg>
      );
    case "layout-grid":
    case "grid":
    case "grid-view":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
          <rect x="9" y="9" width="4.5" height="4.5" rx="0.8" strokeWidth={1.1} />
        </svg>
      );
    case "absolute":
      return (
        <svg {...p}>
          <path d="M2.5 5.5V3a.5.5 0 01.5-.5h2.5M10.5 2.5H13a.5.5 0 01.5.5v2.5M13.5 10.5V13a.5.5 0 01-.5.5h-2.5M5.5 13.5H3a.5.5 0 01-.5-.5v-2.5" strokeWidth={1.3} />
          <rect x="6" y="6" width="4" height="4" rx="0.75" strokeWidth={1.2} />
        </svg>
      );
    case "padding":
    case "padding-all":
    case "padding-sides":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeWidth={1.25} />
          <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" strokeDasharray="1.5 1" strokeWidth={1.1} />
        </svg>
      );
    case "padding-horizontal":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeWidth={1.25} />
          <path d="M5.5 8h5M7 6.5L5.5 8 7 9.5M9 6.5l1.5 1.5-1.5 1.5" strokeWidth={1.2} />
        </svg>
      );
    case "padding-vertical":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeWidth={1.25} />
          <path d="M8 5.5v5M6.5 7L8 5.5 9.5 7M6.5 9L8 10.5 9.5 9" strokeWidth={1.2} />
        </svg>
      );
    case "gap":
      return (
        <svg {...p}>
          <path d="M2.5 3v10M13.5 3v10M5.5 8h5M7 6.5L5.5 8 7 9.5M9 6.5l1.5 1.5-1.5 1.5" strokeWidth={1.2} />
        </svg>
      );
    case "hug":
    case "width-hug":
      return (
        <svg {...p}>
          <path d="M2.5 8h3M13.5 8h-3M5.5 5.5L8 8l-2.5 2.5M10.5 5.5L8 8l2.5 2.5" strokeWidth={1.25} />
        </svg>
      );
    case "height-hug":
      return (
        <svg {...p}>
          <path d="M8 2.5v3M8 13.5v-3M5.5 5.5L8 8l2.5-2.5M5.5 10.5L8 8l2.5 2.5" strokeWidth={1.25} />
        </svg>
      );
    case "fill-container":
    case "width-fill":
      return (
        <svg {...p}>
          <path d="M2.5 8h11M5 5.5L2.5 8 5 10.5M11 5.5l2.5 2.5-2.5 2.5" strokeWidth={1.25} />
        </svg>
      );
    case "height-fill":
      return (
        <svg {...p}>
          <path d="M8 2.5v11M5.5 5L8 2.5 10.5 5M5.5 11L8 13.5l2.5-2.5" strokeWidth={1.25} />
        </svg>
      );
    case "width-min":
    case "width-max":
      return (
        <svg {...p}>
          <path d="M3 2v12M13 2v12M3 8h10" strokeWidth={1.25} />
        </svg>
      );
    case "height-min":
    case "height-max":
      return (
        <svg {...p}>
          <path d="M2 3h12M2 13h12M8 3v10" strokeWidth={1.25} />
        </svg>
      );
    case "corners":
    case "radius":
      return (
        <svg {...p}>
          <path d="M3 13V7a4 4 0 014-4h6" strokeWidth={1.25} />
        </svg>
      );
    case "independent":
      return (
        <svg {...p}>
          <path d="M4.5 7.5V4.5h3M11.5 8.5v3h-3" strokeWidth={1.25} />
        </svg>
      );
    case "constraints":
    case "constr-horiz":
    case "constr-vert":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1.5" strokeWidth={1.2} />
          <path d="M8 3v10M3 8h10" strokeWidth={1.2} />
        </svg>
      );
    case "clip":
    case "overflow-clip":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1.5" strokeWidth={1.25} />
          <path d="M3 3l10 10" strokeWidth={1} />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Boolean Operations
    // -------------------------------------------------------------------------
    case "boolean":
      return (
        <svg {...p}>
          <circle cx="6" cy="8" r="4.5" strokeWidth={1.2} />
          <circle cx="10" cy="8" r="4.5" strokeWidth={1.2} />
        </svg>
      );
    case "boolean-union":
    case "union":
      return (
        <svg {...p}>
          <path d="M2.5 5.5A1.5 1.5 0 014 4h4.5a1.5 1.5 0 011.5 1.5V6H12a1.5 1.5 0 011.5 1.5v4.5A1.5 1.5 0 0112 13.5H7.5A1.5 1.5 0 016 12v-.5H4A1.5 1.5 0 012.5 10V5.5z" strokeWidth={1.25} />
        </svg>
      );
    case "boolean-subtract":
    case "subtract":
      return (
        <svg {...p}>
          <path d="M2.5 4.5A1.5 1.5 0 014 3h5v3.5H5.5V10H2.5V4.5z" strokeWidth={1.25} />
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" strokeDasharray="2 1.5" strokeWidth={1.2} />
        </svg>
      );
    case "boolean-intersect":
    case "intersect":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" strokeWidth={1.1} />
          <rect x="6.5" y="6.5" width="7" height="7" rx="1" strokeWidth={1.1} />
          <rect x="6.5" y="6.5" width="3" height="3" fill="currentColor" stroke="none" />
        </svg>
      );
    case "boolean-exclude":
    case "exclude":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M2.5 4A1.5 1.5 0 014 2.5h5.5A1.5 1.5 0 0111 4v2H9.5V4H4v5.5H6V11H4A1.5 1.5 0 012.5 9.5V4zM5 12a1.5 1.5 0 001.5 1.5H12a1.5 1.5 0 001.5-1.5V6.5A1.5 1.5 0 0012 5H10v1.5h2V12H6.5v-2H5v2z" />
        </svg>
      );
    case "flatten":
      return (
        <svg {...p}>
          <path d="M2.5 7.5l5.5 3 5.5-3M2.5 11l5.5 3 5.5-3M8 2l5.5 3-5.5 3-5.5-3z" strokeWidth={1.25} />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Typography Sizing & Alignment
    // -------------------------------------------------------------------------
    case "text-auto-width":
      return (
        <svg {...p}>
          <path d="M2 3v10M14 3v10M4.5 8h7M6.5 6L4.5 8l2 2M9.5 6l2 2-2 2" strokeWidth={1.25} />
        </svg>
      );
    case "text-auto-height":
      return (
        <svg {...p}>
          <path d="M3 2h10M3 14h10M8 4.5v7M6 6.5L8 4.5l2 2M6 9.5l2 2-2-2" strokeWidth={1.25} />
        </svg>
      );
    case "text-fixed":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeWidth={1.25} />
          <path d="M5.5 6h5M8 6v4.5" strokeWidth={1.25} />
        </svg>
      );
    case "align-left":
    case "align-left-alt":
      return (
        <svg {...p}>
          <path d="M2.5 2v12M5.5 4.5h8M5.5 9.5h5" strokeWidth={1.25} />
        </svg>
      );
    case "align-hcenter":
    case "align-horizontal-center":
    case "align-center":
      return (
        <svg {...p}>
          <path d="M8 2v12M3.5 4.5h9M5.5 9.5h5" strokeWidth={1.25} />
        </svg>
      );
    case "align-right":
    case "align-right-alt":
      return (
        <svg {...p}>
          <path d="M13.5 2v12M2.5 4.5h8M5.5 9.5h5" strokeWidth={1.25} />
        </svg>
      );
    case "align-top":
    case "align-top-alt":
      return (
        <svg {...p}>
          <path d="M2 2.5h12M4.5 5.5v8M9.5 5.5v5" strokeWidth={1.25} />
        </svg>
      );
    case "align-vcenter":
    case "align-vertical-center":
    case "align-middle":
      return (
        <svg {...p}>
          <path d="M2 8h12M4.5 3.5v9M9.5 5.5v5" strokeWidth={1.25} />
        </svg>
      );
    case "align-bottom":
    case "align-bottom-alt":
      return (
        <svg {...p}>
          <path d="M2 13.5h12M4.5 2.5v8M9.5 5.5v5" strokeWidth={1.25} />
        </svg>
      );
    case "distribute-h":
    case "distribute-horizontal":
      return (
        <svg {...p}>
          <path d="M2.5 2.5v11M13.5 2.5v11M6 5.5h4v5H6z" strokeWidth={1.25} />
        </svg>
      );
    case "distribute-v":
    case "distribute-vertical":
      return (
        <svg {...p}>
          <path d="M2.5 2.5h11M2.5 13.5h11M5.5 6h5v4h-5z" strokeWidth={1.25} />
        </svg>
      );
    case "align-text-left":
      return (
        <svg {...p}>
          <path d="M2.5 4h11M2.5 8h7M2.5 12h11" strokeWidth={1.25} />
        </svg>
      );
    case "align-text-center":
      return (
        <svg {...p}>
          <path d="M2.5 4h11M4.5 8h7M2.5 12h11" strokeWidth={1.25} />
        </svg>
      );
    case "align-text-right":
      return (
        <svg {...p}>
          <path d="M2.5 4h11M6.5 8h7M2.5 12h11" strokeWidth={1.25} />
        </svg>
      );
    case "align-text-justified":
    case "align-justified":
      return (
        <svg {...p}>
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" strokeWidth={1.25} />
        </svg>
      );
    case "valign-top":
      return (
        <svg {...p}>
          <path d="M2.5 3h11M5 5.5h6v6H5z" strokeWidth={1.25} />
        </svg>
      );
    case "valign-middle":
      return (
        <svg {...p}>
          <path d="M2.5 8h11M5 4.5h6v7H5z" strokeWidth={1.25} />
        </svg>
      );
    case "valign-bottom":
      return (
        <svg {...p}>
          <path d="M2.5 13h11M5 4.5h6v6H5z" strokeWidth={1.25} />
        </svg>
      );
    case "line-height":
      return (
        <svg {...p}>
          <path d="M3 2.5v11M1.5 5L3 2.5 4.5 5M1.5 11L3 13.5 4.5 11M7.5 4h6M7.5 8h6M7.5 12h6" strokeWidth={1.25} />
        </svg>
      );
    case "letter-spacing":
      return (
        <svg {...p}>
          <path d="M2.5 13.5h11M5 12l-2.5 1.5L5 15M11 12l2.5 1.5-2.5 1.5M5.5 3h5M8 3v7" strokeWidth={1.2} />
        </svg>
      );
    case "paragraph-spacing":
      return (
        <svg {...p}>
          <path d="M3 2h10M3 6h7M3 11h10M3 15h7M12 7v3M10.5 8.5L12 10l1.5-1.5" strokeWidth={1.2} />
        </svg>
      );
    case "leading-trim":
    case "no-trim":
      return (
        <svg {...p}>
          <path d="M2 3h12M2 13h12M4.5 5.5h7M8 5.5v5M6 10.5h4" strokeWidth={1.2} />
        </svg>
      );
    case "font-size":
      return (
        <svg {...p}>
          <path d="M2.5 4h6M5.5 4v9M4 13h3M9.5 7h4M11.5 7v6M10.5 13h2" strokeWidth={1.2} />
        </svg>
      );
    case "type-settings":
      return (
        <svg {...p}>
          <path d="M3 4h10M8 4v8M5.5 12h5" strokeWidth={1.25} />
          <circle cx="12.5" cy="11.5" r="1.5" strokeWidth={1.2} />
        </svg>
      );
    case "bold":
      return (
        <svg {...p}>
          <path d="M4.5 3.5h4.5a2.2 2.2 0 012.2 2.2 2.2 2.2 0 01-2.2 2.2H4.5v-4.4zM4.5 7.9h5a2.4 2.4 0 012.4 2.4 2.4 2.4 0 01-2.4 2.4H4.5V7.9z" strokeWidth={1.3} />
        </svg>
      );
    case "underline":
    case "underline-dashed":
    case "underline-dotted":
    case "underline-wave":
      return (
        <svg {...p}>
          <path d="M4.5 3.5v5a3.5 3.5 0 007 0v-5M3.5 13h9" strokeWidth={1.25} />
        </svg>
      );
    case "strike":
    case "strike-through":
      return (
        <svg {...p}>
          <path d="M2.5 8h11M5.5 5.2c.4-1.3 1.4-1.7 2.5-1.7s2.2.6 2.5 1.7M5.5 10.8c.4 1.3 1.4 1.7 2.5 1.7s2.2-.6 2.5-1.7" strokeWidth={1.25} />
        </svg>
      );
    case "list":
    case "list-view":
    case "list-horizontal":
    case "number-list":
      return (
        <svg {...p}>
          <path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" strokeWidth={1.25} />
          <circle cx="3.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="3.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Dev Mode & Code Generation
    // -------------------------------------------------------------------------
    case "dev":
    case "dev-brackets":
      return (
        <svg {...p}>
          <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" strokeWidth={1.4} />
        </svg>
      );
    case "code":
    case "code-block":
    case "code-snippet":
    case "embed-code":
      return (
        <svg {...p}>
          <rect x="2" y="3" width="12" height="10" rx="2" strokeWidth={1.2} />
          <path d="M5.5 6.5L4 8l1.5 1.5M10.5 6.5L12 8l-1.5 1.5" strokeWidth={1.2} />
        </svg>
      );
    case "inspect":
      return (
        <svg {...p}>
          <path d="M3 2l5 12 2-4.5L14.5 7z" strokeWidth={1.25} />
        </svg>
      );
    case "copy":
    case "duplicate":
      return (
        <svg {...p}>
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" strokeWidth={1.25} />
          <path d="M10.5 5.5V3.5a1.5 1.5 0 00-1.5-1.5H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5h2" strokeWidth={1.25} />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...p}>
          <rect x="3.5" y="4" width="9" height="10" rx="1.5" strokeWidth={1.25} />
          <path d="M6 4V3a1.5 1.5 0 013 0v1" strokeWidth={1.25} />
        </svg>
      );
    case "scissors":
    case "cut":
      return (
        <svg {...p}>
          <circle cx="4.5" cy="4.5" r="1.8" strokeWidth={1.2} />
          <circle cx="4.5" cy="11.5" r="1.8" strokeWidth={1.2} />
          <path d="M6 5.8L13.5 12M6 10.2L13.5 4" strokeWidth={1.25} />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Prototype & Presentation
    // -------------------------------------------------------------------------
    case "play":
    case "preview-prototype":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M4.5 3.2a.8.8 0 00-1.2.7v8.2a.8.8 0 001.2.7l7.5-4.1a.8.8 0 000-1.4L4.5 3.2z" />
        </svg>
      );
    case "proto":
    case "prototyping":
    case "magic-noodle":
    case "noodle":
      return (
        <svg {...p}>
          <circle cx="3.5" cy="8" r="1.5" strokeWidth={1.2} />
          <circle cx="12.5" cy="8" r="1.5" strokeWidth={1.2} />
          <path d="M5 8c2.5 0 3.5-3.5 6-3.5" strokeWidth={1.25} />
        </svg>
      );
    case "back":
    case "navigate-back":
      return (
        <svg {...p}>
          <path d="M12.5 8H3.5M7 4.5L3.5 8 7 11.5" strokeWidth={1.25} />
        </svg>
      );
    case "forward":
    case "navigate-forward":
      return (
        <svg {...p}>
          <path d="M3.5 8h9M9 4.5l3.5 3.5L9 11.5" strokeWidth={1.25} />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Fills, Strokes & Effects
    // -------------------------------------------------------------------------
    case "eyedropper":
      return (
        <svg {...p}>
          <path d="M10.5 2.5l3 3-1.2 1.2-3-3zM8.8 4.7L3.5 10v2.5H6l5.3-5.3" strokeWidth={1.25} />
          <path d="M3.5 13.5h3.5" strokeWidth={1.2} />
        </svg>
      );
    case "fill":
    case "paint":
    case "swatch":
    case "color":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
        </svg>
      );
    case "fill-solid":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeWidth={1.25} />
          <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "gradient-linear":
    case "fill-gradient-linear":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeWidth={1.25} />
          <path d="M2.5 13.5L13.5 2.5" strokeWidth={1.2} />
        </svg>
      );
    case "gradient-radial":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.25} />
          <circle cx="8" cy="8" r="2.5" strokeWidth={1.2} />
        </svg>
      );
    case "gradient-angular":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.25} />
          <path d="M8 8V2.5M8 8l4 4" strokeWidth={1.2} />
        </svg>
      );
    case "gradient-diamond":
      return (
        <svg {...p}>
          <polygon points="8,2.5 13.5,8 8,13.5 2.5,8" strokeWidth={1.25} />
          <polygon points="8,5.5 10.5,8 8,10.5 5.5,8" strokeWidth={1.1} />
        </svg>
      );
    case "effects":
    case "shadows":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="3.5" strokeWidth={1.2} />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" strokeWidth={1.2} />
        </svg>
      );
    case "layer-blur":
    case "layer-blur-medium":
    case "background-blur":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.2} strokeDasharray="2 1.5" />
          <circle cx="8" cy="8" r="2.5" strokeWidth={1} />
        </svg>
      );
    case "mask":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.25} />
          <path d="M8 2.5v11c3 0 5.5-2.5 5.5-5.5S11 2.5 8 2.5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "stroke-inside":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1.5" strokeWidth={1.2} />
          <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" strokeWidth={1.2} />
        </svg>
      );
    case "stroke-center":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1.5" strokeWidth={1.2} />
        </svg>
      );
    case "stroke-outside":
      return (
        <svg {...p}>
          <rect x="4.5" y="4.5" width="7" height="7" rx="0.8" strokeWidth={1.2} />
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeDasharray="2 1.5" strokeWidth={1} />
        </svg>
      );
    case "cap-none":
      return (
        <svg {...p}>
          <path d="M3 8h10" strokeWidth={1.3} />
        </svg>
      );
    case "cap-round":
      return (
        <svg {...p}>
          <path d="M3 8h7.5" strokeWidth={1.3} />
          <circle cx="11.5" cy="8" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "cap-square":
      return (
        <svg {...p}>
          <path d="M3 8h7" strokeWidth={1.3} />
          <rect x="10" y="6.5" width="3" height="3" fill="currentColor" stroke="none" />
        </svg>
      );
    case "join-miter":
      return (
        <svg {...p}>
          <path d="M3.5 12.5V3.5h9" strokeWidth={1.3} strokeLinecap="square" strokeLinejoin="miter" />
        </svg>
      );
    case "join-round":
      return (
        <svg {...p}>
          <path d="M3.5 12.5V6.5a3 3 0 013-3h6" strokeWidth={1.3} />
        </svg>
      );
    case "join-bevel":
      return (
        <svg {...p}>
          <path d="M3.5 12.5V7.5l4-4h5" strokeWidth={1.3} />
        </svg>
      );
    case "dash":
      return (
        <svg {...p}>
          <path d="M2.5 8h2.5M7 8h2.5M11.5 8H14" strokeWidth={1.3} />
        </svg>
      );

    // -------------------------------------------------------------------------
    // Chrome, UI State, Badges & Device Presets
    // -------------------------------------------------------------------------
    case "eye":
      return (
        <svg {...p}>
          <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" strokeWidth={1.25} />
          <circle cx="8" cy="8" r="2" strokeWidth={1.2} />
        </svg>
      );
    case "eye-off":
    case "hidden":
      return (
        <svg {...p}>
          <path d="M2 2l12 12M6.6 6.7A2 2 0 008 10a2 2 0 001.4-.6M4.2 4.4C2.5 5.6 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.3 0 2.5-.4 3.5-.9M7.2 3.6A7 7 0 018 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 01-1.8 2.3" strokeWidth={1.25} />
        </svg>
      );
    case "lock":
    case "lock-locked":
      return (
        <svg {...p}>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" strokeWidth={1.25} />
          <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeWidth={1.25} />
        </svg>
      );
    case "unlock":
    case "lock-open":
      return (
        <svg {...p}>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" strokeWidth={1.25} />
          <path d="M5.5 7V5a2.5 2.5 0 014.8-1" strokeWidth={1.25} />
        </svg>
      );
    case "plus":
      return (
        <svg {...p}>
          <path d="M8 2.5v11M2.5 8h11" strokeWidth={1.3} />
        </svg>
      );
    case "minus":
      return (
        <svg {...p}>
          <path d="M3 8h10" strokeWidth={1.3} />
        </svg>
      );
    case "close":
    case "x-mark":
      return (
        <svg {...p}>
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      );
    case "chevron":
    case "chevron-down":
    case "chevron-down-large":
      return (
        <svg {...p}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      );
    case "chevron-right":
    case "chevron-right-large":
      return (
        <svg {...p}>
          <path d="M6 4l4 4-4 4" />
        </svg>
      );
    case "chevron-up":
      return (
        <svg {...p}>
          <path d="M4 10l4-4 4 4" />
        </svg>
      );
    case "chevrons-down":
      return (
        <svg {...p}>
          <path d="M4 4.5l4 4 4-4M4 8.5l4 4 4-4" />
        </svg>
      );
    case "chevrons-up":
      return (
        <svg {...p}>
          <path d="M4 7.5l4-4 4 4M4 11.5l4-4 4 4" />
        </svg>
      );
    case "more":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <circle cx="3.5" cy="8" r="1.15" />
          <circle cx="8" cy="8" r="1.15" />
          <circle cx="12.5" cy="8" r="1.15" />
        </svg>
      );
    case "trash":
      return (
        <svg {...p}>
          <path d="M3 4.5h10M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5M4.5 4.5l.7 8a1.5 1.5 0 001.5 1.5h2.6a1.5 1.5 0 001.5-1.5l.7-8" strokeWidth={1.25} />
        </svg>
      );
    case "rotate":
    case "rotate-ccw":
      return (
        <svg {...p}>
          <path d="M3.5 8a4.5 4.5 0 108.4-2.6M12.5 2.5v3.5H9" strokeWidth={1.25} />
        </svg>
      );
    case "flip-h":
    case "flip-horizontal":
      return (
        <svg {...p}>
          <path d="M8 2v12M3 11.5L6.5 8 3 4.5zM13 11.5L9.5 8 13 4.5z" strokeWidth={1.2} />
        </svg>
      );
    case "flip-v":
    case "flip-vertical":
      return (
        <svg {...p}>
          <path d="M2 8h12M11.5 3L8 6.5 4.5 3zM11.5 13L8 9.5 4.5 13z" strokeWidth={1.2} />
        </svg>
      );
    case "aspect":
    case "linked":
      return (
        <svg {...p}>
          <rect x="3" y="5.5" width="4.5" height="5" rx="1.5" strokeWidth={1.2} />
          <rect x="8.5" y="5.5" width="4.5" height="5" rx="1.5" strokeWidth={1.2} />
          <path d="M6.5 8h3" strokeWidth={1.3} />
        </svg>
      );
    case "link":
    case "link-connected":
      return (
        <svg {...p}>
          <path d="M6.5 9.5l3-3M9 4.5l1.5-1.5a2.5 2.5 0 013.5 3.5L12.5 8M7 11.5L5.5 13a2.5 2.5 0 01-3.5-3.5L3.5 8" strokeWidth={1.25} />
        </svg>
      );
    case "link-broken":
      return (
        <svg {...p}>
          <path d="M9 4.5l1.5-1.5a2.5 2.5 0 013.5 3.5L12.5 8M7 11.5L5.5 13a2.5 2.5 0 01-3.5-3.5L3.5 8M2 2l12 12" strokeWidth={1.25} />
        </svg>
      );
    case "minimize":
      return (
        <svg {...p}>
          <path d="M3 8h10M6 5L3 8l3 3M10 5l3 3-3 3" strokeWidth={1.25} />
        </svg>
      );
    case "open":
      return (
        <svg {...p}>
          <path d="M9 3h4v4M13 3 7 9" strokeWidth={1.25} />
          <path d="M12 10v3H3V4h3" strokeWidth={1.25} />
        </svg>
      );
    case "help":
    case "info":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.25} />
          <path d="M6.5 6.2a1.6 1.6 0 012.9 1c0 1.1-1.4 1.5-1.4 2.5" strokeWidth={1.25} />
          <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case "settings":
    case "adjust":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="2.5" strokeWidth={1.2} />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" strokeWidth={1.2} />
        </svg>
      );
    case "resources":
    case "community":
    case "ui-kit":
      return (
        <svg {...p}>
          <path d="M8 2.2l3.2 3.2L8 8.6 4.8 5.4z" strokeWidth={1.2} />
          <path d="M8 8.6l3.2 3.2-1.4 1.4-3.2-3.2zM4.8 5.4L2.4 7.8l1.4 1.4 3.2-3.2z" strokeWidth={1.2} />
        </svg>
      );
    case "tools":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="4.8" height="4.8" rx="1.2" strokeWidth={1.2} />
          <rect x="8.7" y="2.5" width="4.8" height="4.8" rx="1.2" strokeWidth={1.2} />
          <rect x="2.5" y="8.7" width="4.8" height="4.8" rx="1.2" strokeWidth={1.2} />
          <path d="M10.2 11.1h3M11.7 9.6v3" strokeWidth={1.25} />
        </svg>
      );
    case "agent":
    case "ai":
    case "qwand":
    case "wand":
      return (
        <svg {...p}>
          <path d="M8 2l1.3 3.5L12.8 7 9.3 8.5 8 12 6.7 8.5 3.2 7l3.5-1.5z" strokeWidth={1.2} />
          <path d="M12.5 2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "vars":
    case "variable":
      return (
        <svg {...p}>
          <rect x="2.5" y="4.5" width="11" height="7" rx="3.5" strokeWidth={1.2} />
          <circle cx="6" cy="8" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "styles":
    case "text-library":
    case "library":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <circle cx="5" cy="5" r="1.5" />
          <circle cx="11" cy="5" r="1.5" />
          <circle cx="5" cy="11" r="1.5" />
          <circle cx="11" cy="11" r="1.5" />
        </svg>
      );
    case "layers":
    case "stack":
      return (
        <svg {...p}>
          <path d="M2.5 6L8 3.2l5.5 2.8L8 8.8z" strokeWidth={1.25} />
          <path d="M2.5 8.8L8 11.6l5.5-2.8M2.5 11.6L8 14.4l5.5-2.8" strokeWidth={1.25} />
        </svg>
      );
    case "page":
    case "pages":
      return (
        <svg {...p}>
          <path d="M4 2.5h5.5L12.5 5.5v8H4z" strokeWidth={1.25} />
          <path d="M9.5 2.5v3h3" strokeWidth={1.25} />
        </svg>
      );
    case "group":
    case "collapse-layers":
      return (
        <svg {...p} strokeDasharray="2 1.4">
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeWidth={1.2} />
        </svg>
      );
    case "target":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" strokeWidth={1.2} />
          <circle cx="8" cy="8" r="2.5" strokeWidth={1.2} />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2" strokeWidth={1.2} />
        </svg>
      );
    case "phone":
    case "mobile":
      return (
        <svg {...p}>
          <rect x="4.5" y="2" width="7" height="12" rx="1.5" strokeWidth={1.25} />
          <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case "tablet":
      return (
        <svg {...p}>
          <rect x="3" y="2.5" width="10" height="11" rx="1.5" strokeWidth={1.25} />
          <circle cx="8" cy="11" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case "desktop":
      return (
        <svg {...p}>
          <rect x="2.5" y="3" width="11" height="7.5" rx="1.5" strokeWidth={1.25} />
          <path d="M5.5 13.5h5M8 10.5v3" strokeWidth={1.25} />
        </svg>
      );
    case "slide":
    case "slides":
    case "play-rectangle":
      return (
        <svg {...p}>
          <rect x="2.5" y="3" width="11" height="8" rx="1.5" strokeWidth={1.25} />
          <path d="M4 14l4-3 4 3" strokeWidth={1.25} />
        </svg>
      );
    case "check":
    case "checkmark":
    case "check-large":
      return (
        <svg {...p}>
          <path d="M3.5 8.5l3 3 6-6" strokeWidth={1.4} />
        </svg>
      );
    case "folder":
      return (
        <svg {...p}>
          <path d="M2.5 4a1.5 1.5 0 011.5-1.5h3l1.5 1.5h3.5A1.5 1.5 0 0113.5 5.5v6a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 11.5v-7.5z" strokeWidth={1.25} />
        </svg>
      );
    case "import":
      return (
        <svg {...p}>
          <path d="M8 2.5v7.5M5.5 7.5L8 10l2.5-2.5M2.5 11v2a.5.5 0 00.5.5h10a.5.5 0 00.5-.5v-2" strokeWidth={1.25} />
        </svg>
      );
    case "export":
      return (
        <svg {...p}>
          <path d="M8 10V2.5M5.5 5L8 2.5 10.5 5M2.5 9v3.5a1 1 0 001 1h9a1 1 0 001-1V9" strokeWidth={1.25} />
        </svg>
      );
    case "logo":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
          <rect width="24" height="24" rx="4" fill="#1A1A1A" />
          <path
            fill="#1BCB55"
            d="M16.7072 6.01489L16.5894 6.17866L15.9515 7.08685V7.10174H15.9445L15.3205 8.00248L15.1818 8.19603L14.6826 8.91067L14.4191 9.29032L14.0447 9.8263L13.6564 10.3846L13.4137 10.7345L12.9006 11.4715L12.7758 11.6427L12.1448 12.5509L12.131 12.5583L11.5 13.4591L11.6317 13.6452L12.131 14.3672L12.3875 14.7395L12.7619 15.2754L13.1433 15.8263L13.3929 16.1836L13.906 16.9132L14.0308 17.0918L14.6687 18H15.9307H17.1995H18.4684L17.8374 17.0844L17.7126 16.9057L17.1995 16.1762L16.9499 15.8189L16.5686 15.268L16.1941 14.732L15.9376 14.3598L15.4384 13.6377L15.3066 13.4442L15.9376 12.5434L16.5755 11.6203L16.6934 11.4491L17.2065 10.7122L17.4492 10.3623L17.8374 9.80397L18.2119 9.26799L18.4753 8.88834L18.9746 8.1737L19.1133 7.98015L19.7373 7.08685V7.07196L20.3821 6.16377L20.5 6H16.6934L16.7072 6.01489Z"
          />
          <path
            fill="#FFFFFF"
            d="M8.90422 15.8311L9.29124 15.2795L9.67123 14.7429L9.93159 14.3702L10.4382 13.6472L10.5719 13.4609L11.2123 12.559L11.8597 11.6348L11.9793 11.4634L12.5 10.7255L12.2467 10.3752L11.8526 9.81615L11.4726 9.2795L11.2052 8.89938L10.6986 8.18385L10.5579 7.99006L9.92455 7.0882V7.07329H9.91751L9.27013 6.16398L9.15051 6H5.31548L5.43511 6.16398L6.07545 7.07329V7.0882L6.72283 7.99006L6.86357 8.18385L7.37021 8.89938L7.63761 9.2795L8.01055 9.81615L8.40461 10.3752L8.65794 10.7255L8.13722 11.4634L8.01055 11.6348L7.37021 12.5441L6.72987 13.4534L6.59617 13.6398L6.08952 14.3627L5.82916 14.7354L5.44918 15.272L5.06216 15.8236L4.80883 16.1814L4.28812 16.9118L4.16145 17.0907L3.52111 18H3.5H4.78772H6.07545H7.36317L8.01055 17.0832L8.13722 16.9043L8.65794 16.1739L8.91126 15.8161L8.90422 15.8311Z"
          />
        </svg>
      );
    case "upload":
    case "upload-alt":
      return (
        <svg {...p}>
          <path d="M8 2.5v7.5M5.5 7.5L8 10l2.5-2.5M2.5 11v2a.5.5 0 00.5.5h10a.5.5 0 00.5-.5v-2" strokeWidth={1.25} />
        </svg>
      );
    case "type":
      return (
        <svg {...p}>
          <path d="M3 3.5h10M8 3.5v9.5M5.5 13h5" strokeWidth={1.3} />
        </svg>
      );
    case "pointer":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M3 2v11.5l3.2-3 2.3 4.5 1.7-.8-2.3-4.4 4.5-.2z" />
        </svg>
      );
    case "history":
      return (
        <svg {...p}>
          <path d="M3.5 8a4.5 4.5 0 101.3-3.2L3 6.5M3 3v3.5h3.5" strokeWidth={1.25} />
        </svg>
      );
    case "fullscreen":
    case "maximize":
      return (
        <svg {...p}>
          <path d="M2.5 3.5V3a.5.5 0 01.5-.5h2.5M10.5 2.5H13a.5.5 0 01.5.5v2.5M13.5 10.5V13a.5.5 0 01-.5.5h-2.5M5.5 13.5H3a.5.5 0 01-.5-.5v-2.5" strokeWidth={1.3} />
        </svg>
      );
    case "arrow-left":
      return (
        <svg {...p}>
          <path d="M12.5 8H3.5M7 4.5L3.5 8 7 11.5" strokeWidth={1.25} />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="4.5" strokeWidth={1.2} />
        </svg>
      );
  }
}

export const TOOL_ICON: Record<Tool, string> = {
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

export function kindIcon(k: string, imageSrc?: string): string {
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
