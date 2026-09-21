import type { CSSProperties, SVGProps } from "react";
import type { Tool } from "../engine/types";

/** 16×16 Figma-style glyphs: 1.25px stroke, round caps, currentColor. */
const S: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const style: CSSProperties = { width: size, height: size, display: "block" };
  const p = { ...S, className, style };
  switch (name) {
    case "move":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M3.2 1.6l.1 12.2 3.3-3.1 2.1 4.6 1.85-.85-2.15-4.55 4.5-.15z" />
        </svg>
      );
    case "scale":
      return (
        <svg {...p}>
          <path d="M6 2.5H2.5V6M10 13.5h3.5V10" />
          <path d="M2.8 2.8l4.2 4.2M13.2 13.2l-4.2-4.2" />
        </svg>
      );
    case "frame":
      return (
        <svg {...p}>
          <path d="M5.25 1.5v3.5M10.75 1.5v3.5M5.25 11v3.5M10.75 11v3.5" />
          <path d="M1.5 5.25h3.5M11 5.25h3.5M1.5 10.75h3.5M11 10.75h3.5" />
        </svg>
      );
    case "section":
      return (
        <svg {...p}>
          <rect x="2.5" y="4.5" width="11" height="9" rx="1.5" />
          <path d="M2.5 7.25h11M5 4.5V3.25h6V4.5" />
        </svg>
      );
    case "slice":
      return (
        <svg {...p} strokeDasharray="2 1.5">
          <rect x="2.5" y="2.5" width="11" height="11" rx="0.5" />
        </svg>
      );
    case "text":
      return (
        <svg {...p} strokeWidth={1.4}>
          <path d="M3.5 3.5h9M8 3.5v9.2M5.5 12.7h5" />
        </svg>
      );
    case "rect":
      return (
        <svg {...p}>
          <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.75" />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.25" />
        </svg>
      );
    case "line":
      return (
        <svg {...p}>
          <path d="M3 13L13 3" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...p}>
          <path d="M3.5 12.5L12.5 3.5" />
          <path d="M7 3.5h5.5V9" />
        </svg>
      );
    case "poly":
      return (
        <svg {...p}>
          <path d="M8 2.6l6 10.8H2z" />
        </svg>
      );
    case "star":
      return (
        <svg {...p}>
          <path d="M8 2.2l1.62 3.92 4.28.34-3.28 2.66 1 4.16L8 11.4l-3.62 1.88 1-4.16L2.1 6.46l4.28-.34z" />
        </svg>
      );
    case "image":
      return (
        <svg {...p}>
          <rect x="2.5" y="3.25" width="11" height="9.5" rx="1.25" />
          <circle cx="6" cy="6.6" r="1.15" />
          <path d="M2.8 11.2l3.4-2.8 2.2 1.8 2.3-2.1 2.5 3.1" />
        </svg>
      );
    case "pen":
      return (
        <svg {...p}>
          <path d="M10.2 2.6l3.2 3.2-7.4 7.4H2.8v-3.2z" />
          <path d="M8.6 4.2l3.2 3.2" />
          <path d="M2.8 13.2h10.4" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...p}>
          <path d="M11.4 2.4l2.2 2.2-8.3 8.3H3.1v-2.2z" />
          <path d="M10 3.8l2.2 2.2" />
        </svg>
      );
    case "brush":
      return (
        <svg {...p}>
          <path d="M6.2 9.2c0 2.1 1.1 3.6 1.8 3.6s1.8-1.5 1.8-3.6" />
          <path d="M6.2 9.2V4.4c0-1.5 1.6-2.4 1.8-2.4s1.8.9 1.8 2.4v4.8" />
        </svg>
      );
    case "eraser":
      return (
        <svg {...p}>
          <path d="M5.2 13.2L2.6 10.6a1.4 1.4 0 010-2l6-6a1.4 1.4 0 012 0L13.4 5.4a1.4 1.4 0 010 2l-6 6H5.2z" />
          <path d="M6.2 5.2l4.6 4.6" />
        </svg>
      );
    case "comment":
      return (
        <svg {...p}>
          <path d="M3.2 3.4h9.6a1.2 1.2 0 011.2 1.2v5.2a1.2 1.2 0 01-1.2 1.2H7.2L3.2 13.6V4.6A1.2 1.2 0 014.4 3.4z" />
        </svg>
      );
    case "hand":
      return (
        <svg {...p}>
          <path d="M5.4 7.2V4.6a1 1 0 012 0V7M8 6.6V3.7a1 1 0 012 0V7M10.6 7.1V4.8a1 1 0 012 0v5.1a4.1 4.1 0 01-4.1 4.1H8A3.8 3.8 0 014.2 10V7.6a1 1 0 012 0v.8" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="3.6" />
          <path d="M12.6 12.6L9.6 9.6" />
        </svg>
      );
    case "eye":
      return (
        <svg {...p}>
          <path d="M1.6 8s2.6-4.4 6.4-4.4S14.4 8 14.4 8s-2.6 4.4-6.4 4.4S1.6 8 1.6 8z" />
          <circle cx="8" cy="8" r="1.7" />
        </svg>
      );
    case "eye-off":
      return (
        <svg {...p}>
          <path d="M2.2 2.2l11.6 11.6" />
          <path d="M6.5 6.6A2 2 0 008 10a2 2 0 001.7-3M4.2 4.6C2.6 5.8 1.6 8 1.6 8s2.6 4.4 6.4 4.4c1.2 0 2.3-.3 3.3-.8M7.1 3.6A6.7 6.7 0 018 3.6c3.8 0 6.4 4.4 6.4 4.4a10 10 0 01-1.7 2.2" />
        </svg>
      );
    case "lock":
      return (
        <svg {...p}>
          <rect x="3.4" y="7.2" width="9.2" height="6.4" rx="1.2" />
          <path d="M5.4 7.2V5.4a2.6 2.6 0 015.2 0v1.8" />
        </svg>
      );
    case "unlock":
      return (
        <svg {...p}>
          <rect x="3.4" y="7.2" width="9.2" height="6.4" rx="1.2" />
          <path d="M5.4 7.2V5.4a2.6 2.6 0 014.8-1.4" />
        </svg>
      );
    case "plus":
      return (
        <svg {...p}>
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      );
    case "minus":
      return (
        <svg {...p}>
          <path d="M3.4 8h9.2" />
        </svg>
      );
    case "x-mark":
      return (
        <svg {...p}>
          <path d="M3.4 3.4l9.2 9.2M12.6 3.4L3.4 12.6" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...p} strokeWidth={1.5}>
          <path d="M5 6.4L8 9.4l3-3" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...p} strokeWidth={1.5}>
          <path d="M6.4 4.2L9.6 8l-3.2 3.8" />
        </svg>
      );
    case "play":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <path d="M5 3.4v9.2L13 8z" />
        </svg>
      );
    case "share":
      return (
        <svg {...p}>
          <circle cx="4.2" cy="8" r="1.6" />
          <circle cx="11.4" cy="4.2" r="1.6" />
          <circle cx="11.4" cy="11.8" r="1.6" />
          <path d="M5.6 7.3l4.2-2.4M5.6 8.7l4.2 2.4" />
        </svg>
      );
    case "rotate":
      return (
        <svg {...p}>
          <path d="M3.4 8a4.6 4.6 0 108.4-2.6" />
          <path d="M12.4 2.8v3.2H9.2" />
        </svg>
      );
    case "radius":
      return (
        <svg {...p}>
          <path d="M3.2 12.8V6.2A3 3 0 016.2 3.2h6.6" />
        </svg>
      );
    case "align-left":
      return (
        <svg {...p}>
          <path d="M2.5 3.2v9.6M5.5 5.2h8M5.5 10.8h5.5" />
        </svg>
      );
    case "align-hcenter":
      return (
        <svg {...p}>
          <path d="M8 2.8v10.4M4.2 5.2h7.6M5.4 10.8h5.2" />
        </svg>
      );
    case "align-right":
      return (
        <svg {...p}>
          <path d="M13.5 3.2v9.6M2.5 5.2h8M5.5 10.8h5.5" />
        </svg>
      );
    case "align-top":
      return (
        <svg {...p}>
          <path d="M3.2 2.5h9.6M5.2 5.5v8M10.8 5.5v5.5" />
        </svg>
      );
    case "align-vcenter":
      return (
        <svg {...p}>
          <path d="M2.8 8h10.4M5.2 4.2v7.6M10.8 5.4v5.2" />
        </svg>
      );
    case "align-bottom":
      return (
        <svg {...p}>
          <path d="M3.2 13.5h9.6M5.2 2.5v8M10.8 5v5.5" />
        </svg>
      );
    case "layout-h":
      return (
        <svg {...p}>
          <rect x="1.8" y="4.2" width="4" height="7.6" rx="0.8" />
          <rect x="6.8" y="4.2" width="2.4" height="7.6" rx="0.8" />
          <rect x="10.2" y="4.2" width="4" height="7.6" rx="0.8" />
        </svg>
      );
    case "layout-v":
      return (
        <svg {...p}>
          <rect x="4.2" y="1.8" width="7.6" height="4" rx="0.8" />
          <rect x="4.2" y="6.8" width="7.6" height="2.4" rx="0.8" />
          <rect x="4.2" y="10.2" width="7.6" height="4" rx="0.8" />
        </svg>
      );
    case "clip":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1.2" />
          <path d="M6.2 8.8l1.6 1.6 2.4-3.4" />
        </svg>
      );
    case "effects":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="3.2" />
          <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
        </svg>
      );
    case "code":
      return (
        <svg {...p}>
          <path d="M5.4 4.6L2.4 8l3 3.4M10.6 4.6l3 3.4-3 3.4M9 3.4L7 12.6" />
        </svg>
      );
    case "proto":
      return (
        <svg {...p}>
          <circle cx="3.6" cy="8" r="1.6" />
          <circle cx="12.4" cy="4.4" r="1.6" />
          <circle cx="12.4" cy="11.6" r="1.6" />
          <path d="M5.2 7.4C7.4 7.4 8.4 4.4 10.8 4.4M5.2 8.6C7.4 8.6 8.4 11.6 10.8 11.6" />
        </svg>
      );
    case "page":
      return (
        <svg {...p}>
          <path d="M4.2 2.4h5.4L12.4 5.2v8.4H4.2z" />
          <path d="M9.4 2.4v3h3" />
        </svg>
      );
    case "component":
      return (
        <svg {...p}>
          <path d="M8 2.2l4.6 4.6L8 13.4 3.4 8.8z" />
        </svg>
      );
    case "group":
      return (
        <svg {...p} strokeDasharray="2 1.4">
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
        </svg>
      );
    case "menu":
      return (
        <svg {...p}>
          <path d="M2.8 4.2h10.4M2.8 8h10.4M2.8 11.8h10.4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="2.1" />
          <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M4 4l1.1 1.1M10.9 10.9L12 12M12 4l-1.1 1.1M5.1 10.9L4 12" />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="3.5" />
          <path d="M12.5 12.5L9.6 9.6M7 5.4v3.2M5.4 7h3.2" />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="3.5" />
          <path d="M12.5 12.5L9.6 9.6M5.4 7h3.2" />
        </svg>
      );
    case "figma":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
          <path fill="#F24E1E" d="M5.2 1.4h2.8a2.8 2.8 0 010 5.6H5.2z" />
          <path fill="#FF7262" d="M8 1.4h2.8a2.8 2.8 0 010 5.6H8z" />
          <path fill="#A259FF" d="M5.2 7h2.8a2.8 2.8 0 010 5.6H5.2z" />
          <path fill="#1ABCFE" d="M8 7h2.8A2.8 2.8 0 118 9.8z" />
          <path fill="#0ACF83" d="M5.2 12.6a2.8 2.8 0 112.8-2.8v2.8z" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
  }
}

export const TOOL_ICON: Record<Tool, string> = {
  select: "move",
  scale: "scale",
  frame: "frame",
  slice: "slice",
  text: "text",
  rect: "rect",
  ellipse: "ellipse",
  line: "line",
  arrow: "arrow",
  poly: "poly",
  star: "star",
  pen: "pen",
  pencil: "pencil",
  brush: "brush",
  eraser: "eraser",
  comment: "comment",
  hand: "hand",
};

export function kindIcon(k: string): string {
  switch (k) {
    case "frame":
      return "frame";
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
    default:
      return "rect";
  }
}
