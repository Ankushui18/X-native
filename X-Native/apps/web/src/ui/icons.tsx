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
    case "more":
      return (
        <svg {...p} fill="currentColor" stroke="none">
          <circle cx="3.5" cy="8" r="1.15" />
          <circle cx="8" cy="8" r="1.15" />
          <circle cx="12.5" cy="8" r="1.15" />
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
    case "distribute-h":
      return (
        <svg {...p}>
          <path d="M2.5 3.2v9.6M13.5 3.2v9.6M6 5.5h4v5H6z" />
        </svg>
      );
    case "distribute-v":
      return (
        <svg {...p}>
          <path d="M3.2 2.5h9.6M3.2 13.5h9.6M5.5 6h5v4h-5z" />
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
    case "layout-none":
      return (
        <svg {...p}>
          <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="0.8" />
          <rect x="9" y="2.4" width="4.6" height="4.6" rx="0.8" />
          <rect x="2.4" y="9" width="4.6" height="4.6" rx="0.8" />
          <rect x="9" y="9" width="4.6" height="4.6" rx="0.8" />
        </svg>
      );
    case "layout-grid":
      return (
        <svg {...p}>
          <rect x="2.4" y="2.4" width="4.4" height="4.4" rx="0.6" />
          <rect x="9.2" y="2.4" width="4.4" height="4.4" rx="0.6" />
          <rect x="2.4" y="9.2" width="4.4" height="4.4" rx="0.6" />
          <rect x="9.2" y="9.2" width="4.4" height="4.4" rx="0.6" />
        </svg>
      );
    case "clip":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1.2" />
        </svg>
      );
    case "constraints":
      return (
        <svg {...p}>
          <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1" />
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      );
    case "flip-h":
      return (
        <svg {...p}>
          <path d="M8 2.4v11.2M3.4 11.6L6.6 8 3.4 4.4zM12.6 11.6L9.4 8l3.2-3.6z" />
        </svg>
      );
    case "flip-v":
      return (
        <svg {...p}>
          <path d="M2.4 8h11.2M11.6 3.4L8 6.6 4.4 3.4zM11.6 12.6L8 9.4l-3.6 3.2z" />
        </svg>
      );
    case "independent":
      return (
        <svg {...p}>
          <path d="M4.2 8.8V5.2A1.2 1.2 0 015.4 4h3.6M11.8 7.2v3.6A1.2 1.2 0 0110.6 12H7" />
        </svg>
      );
    case "padding":
      return (
        <svg {...p}>
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
          <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.6" />
        </svg>
      );
    case "gap":
      return (
        <svg {...p}>
          <path d="M3 4.2h4.4v7.6H3zM8.6 4.2H13v7.6H8.6z" />
        </svg>
      );
    case "hug":
      return (
        <svg {...p}>
          <path d="M4.2 3.4h7.6M4.2 12.6h7.6M6.2 6.2h3.6v3.6H6.2z" />
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
    case "dev":
      return (
        <svg {...p}>
          <path d="M5.4 4.6L2.4 8l3 3.4M10.6 4.6l3 3.4-3 3.4" />
        </svg>
      );
    case "resources":
      return (
        <svg {...p}>
          <path d="M8 2.4l3.2 3.2L8 8.8 4.8 5.6z" />
          <path d="M8 8.8l3.2 3.2-1.4 1.4-3.2-3.2zM4.8 5.6L2.4 8l1.4 1.4 3.2-3.2z" />
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
    case "layers":
      return (
        <svg {...p}>
          <path d="M2.6 6.2L8 3.4l5.4 2.8L8 9z" />
          <path d="M2.6 8.8L8 11.6l5.4-2.8" />
        </svg>
      );
    case "vars":
      return (
        <svg {...p}>
          <rect x="2.6" y="2.6" width="4.6" height="4.6" rx="1" />
          <rect x="8.8" y="2.6" width="4.6" height="4.6" rx="1" />
          <rect x="2.6" y="8.8" width="4.6" height="4.6" rx="1" />
          <rect x="8.8" y="8.8" width="4.6" height="4.6" rx="1" />
        </svg>
      );
    case "tools":
      return (
        <svg {...p}>
          <rect x="2.6" y="2.6" width="4.8" height="4.8" rx="1.2" />
          <rect x="8.6" y="2.6" width="4.8" height="4.8" rx="1.2" />
          <rect x="2.6" y="8.6" width="4.8" height="4.8" rx="1.2" />
          <path d="M10.2 10.2h4.2M12.3 8.1v4.2" />
        </svg>
      );
    case "agent":
      return (
        <svg {...p}>
          <path d="M8 2.2l1.1 3.2H12.6L9.8 7.4l1.1 3.2L8 8.6l-2.9 2-1.1-3.2L1.4 5.4h3.5z" />
        </svg>
      );
    case "minimize":
      return (
        <svg {...p}>
          <path d="M3.2 8h9.6M6.2 4.6L3.2 8l3 3.4M9.8 4.6l3 3.4-3 3.4" />
        </svg>
      );
    case "type-settings":
      return (
        <svg {...p}>
          <path d="M3.2 4.2h9.6M8 4.2v7.6M4.6 12.4h6.8" />
          <circle cx="12.2" cy="11.6" r="1.6" />
        </svg>
      );
    case "align-text-left":
      return (
        <svg {...p}>
          <path d="M3 4.2h10M3 8h7M3 11.8h10" />
        </svg>
      );
    case "align-text-center":
      return (
        <svg {...p}>
          <path d="M3 4.2h10M4.5 8h7M3 11.8h10" />
        </svg>
      );
    case "align-text-right":
      return (
        <svg {...p}>
          <path d="M3 4.2h10M6 8h7M3 11.8h10" />
        </svg>
      );
    case "align-text-justified":
      return (
        <svg {...p}>
          <path d="M3 4.2h10M3 8h10M3 11.8h10" />
        </svg>
      );
    case "valign-top":
      return (
        <svg {...p}>
          <path d="M3 3.4h10M5 6.2h6v6H5z" />
        </svg>
      );
    case "valign-middle":
      return (
        <svg {...p}>
          <path d="M3 8h10M5 4.4h6v7.2H5z" />
        </svg>
      );
    case "valign-bottom":
      return (
        <svg {...p}>
          <path d="M3 12.6h10M5 3.8h6v6H5z" />
        </svg>
      );
    case "underline":
      return (
        <svg {...p}>
          <path d="M4.2 3.4v5.2a3.8 3.8 0 007.6 0V3.4M3.4 13h9.2" />
        </svg>
      );
    case "strike":
      return (
        <svg {...p}>
          <path d="M3 8h10M5.2 5.2c.4-1.4 1.6-2 2.8-2s2.4.8 2.8 2M5.2 10.8c.5 1.4 1.7 2.2 3 2.2s2.4-.8 2.8-2" />
        </svg>
      );
    case "list":
      return (
        <svg {...p}>
          <path d="M6.4 4.2h6.6M6.4 8h6.6M6.4 11.8h6.6" />
          <circle cx="3.6" cy="4.2" r="0.9" fill="currentColor" />
          <circle cx="3.6" cy="8" r="0.9" fill="currentColor" />
          <circle cx="3.6" cy="11.8" r="0.9" fill="currentColor" />
        </svg>
      );
    case "stroke-inside":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1" />
          <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.4" />
        </svg>
      );
    case "stroke-center":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="10" height="10" rx="1" />
        </svg>
      );
    case "stroke-outside":
      return (
        <svg {...p}>
          <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="0.6" />
          <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.2" strokeDasharray="2 1.5" />
        </svg>
      );
    case "eyedropper":
      return (
        <svg {...p}>
          <path d="M10.2 2.6l3.2 3.2-1.1 1.1-3.2-3.2z" />
          <path d="M8.6 4.8L3.4 10v2.6H6l5.2-5.2" />
          <path d="M3.2 13.4h4" />
        </svg>
      );
    case "copy":
      return (
        <svg {...p}>
          <rect x="5.4" y="5.4" width="7.6" height="7.6" rx="1.2" />
          <path d="M10.6 5.2V3.8A1.2 1.2 0 009.4 2.6H3.8A1.2 1.2 0 002.6 3.8v5.6A1.2 1.2 0 003.8 10.6h1.4" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...p}>
          <rect x="3.6" y="3.8" width="8.8" height="10" rx="1.2" />
          <path d="M6 3.8V3a2 2 0 014 0v.8" />
        </svg>
      );
    case "scissors":
      return (
        <svg {...p}>
          <circle cx="4.2" cy="4.4" r="1.6" />
          <circle cx="4.2" cy="11.6" r="1.6" />
          <path d="M5.6 5.4L13.2 12M5.6 10.6L13.2 4" />
        </svg>
      );
    case "trash":
      return (
        <svg {...p}>
          <path d="M3.2 5.2h9.6M6.2 5.2V3.6h3.6v1.6M4.6 5.2l.6 7.4h5.6l.6-7.4" />
        </svg>
      );
    case "chevrons-up":
      return (
        <svg {...p}>
          <path d="M4.2 8.4L8 4.6l3.8 3.8M4.2 11.6L8 7.8l3.8 3.8" />
        </svg>
      );
    case "chevron-up":
      return (
        <svg {...p}>
          <path d="M4.2 10L8 6.2 11.8 10" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...p}>
          <path d="M4.2 6L8 9.8 11.8 6" />
        </svg>
      );
    case "chevrons-down":
      return (
        <svg {...p}>
          <path d="M4.2 4.4L8 8.2l3.8-3.8M4.2 7.6L8 11.4l3.8-3.8" />
        </svg>
      );
    case "help":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.4" />
          <path d="M6.4 6.2a1.6 1.6 0 012.8 1.1c0 1.1-1.6 1.4-1.6 2.4" />
          <circle cx="8" cy="11.4" r="0.6" fill="currentColor" stroke="none" />
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
    default:
      return "rect";
  }
}
