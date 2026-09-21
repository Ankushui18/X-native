import type { Tool } from "../engine/types";

export function Icon({
  name,
  className = "icon",
}: {
  name: string;
  className?: string;
}) {
  const p = {
    className,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
  };
  switch (name) {
    case "mouse-pointer-2":
      return (
        <svg {...p}>
          <path d="M4 4l7.5 16 1.8-6.7L20 11.5z" />
        </svg>
      );
    case "maximize":
      return (
        <svg {...p}>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      );
    case "frame":
      return (
        <svg {...p}>
          <path d="M6 3v18M18 3v18M3 6h18M3 18h18" />
        </svg>
      );
    case "scissors":
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M8.5 7.5L21 18M8.5 16.5L21 6" />
        </svg>
      );
    case "type":
      return (
        <svg {...p}>
          <path d="M4 7V5h16v2M12 5v14M8 19h8" />
        </svg>
      );
    case "square":
      return (
        <svg {...p}>
          <rect x="5" y="5" width="14" height="14" rx="1" />
        </svg>
      );
    case "circle":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
    case "line":
      return (
        <svg {...p}>
          <path d="M5 19L19 5" />
        </svg>
      );
    case "arrow-up-right":
      return (
        <svg {...p}>
          <path d="M7 17L17 7M9 7h8v8" />
        </svg>
      );
    case "triangle":
      return (
        <svg {...p}>
          <path d="M12 4l9 16H3z" />
        </svg>
      );
    case "star":
      return (
        <svg {...p}>
          <path d="M12 3l2.6 6.5L21 10l-5 4.2L17.5 21 12 17.3 6.5 21 8 14.2 3 10l6.4-.5z" />
        </svg>
      );
    case "pen-tool":
      return (
        <svg {...p}>
          <path d="M12 19l7-7-4-4-7 7v4h4zM14 7l3 3" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...p}>
          <path d="M12 20h9M16.5 3.5l4 4L8 20H4v-4z" />
        </svg>
      );
    case "brush":
      return (
        <svg {...p}>
          <path d="M7 15c0 2 1.5 4 5 4s5-2 5-4M9 15V5a3 3 0 016 0v10" />
        </svg>
      );
    case "eraser":
      return (
        <svg {...p}>
          <path d="M4 16l8-8 6 6-8 8H6zM8 12l6 6" />
        </svg>
      );
    case "message-circle":
      return (
        <svg {...p}>
          <path d="M21 12a8 8 0 11-3.2-6.4L21 6v6z" />
        </svg>
      );
    case "hand":
      return (
        <svg {...p}>
          <path d="M8 11V6a1 1 0 012 0v5M12 10V4a1 1 0 012 0v6M16 11V7a1 1 0 012 0v8a5 5 0 01-5 5h-1a6 6 0 01-6-6v-3a1 1 0 012 0" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      );
    case "eye":
      return (
        <svg {...p}>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "eye-off":
      return (
        <svg {...p}>
          <path d="M3 3l18 18M10.6 10.6A3 3 0 0012 15a3 3 0 002.4-4.4M6.1 6.1C3.5 8 2 12 2 12s4 7 10 7c1.8 0 3.4-.5 4.8-1.3M9.9 4.2A11 11 0 0112 4c6 0 10 8 10 8a18 18 0 01-2.2 3.1" />
        </svg>
      );
    case "lock":
      return (
        <svg {...p}>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 018 0v3" />
        </svg>
      );
    case "unlock":
      return (
        <svg {...p}>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 017.5-2" />
        </svg>
      );
    case "plus":
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "x-mark":
      return (
        <svg {...p}>
          <path d="M5 5l14 14M19 5L5 19" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}

export const TOOL_ICON: Record<Tool, string> = {
  select: "mouse-pointer-2",
  scale: "maximize",
  frame: "frame",
  slice: "scissors",
  text: "type",
  rect: "square",
  ellipse: "circle",
  line: "line",
  arrow: "arrow-up-right",
  poly: "triangle",
  star: "star",
  pen: "pen-tool",
  pencil: "pencil",
  brush: "brush",
  eraser: "eraser",
  comment: "message-circle",
  hand: "hand",
};
