/**
 * x-ui — shared design-system primitives
 *
 * tokens → components (Button/Input/Select/PropertyField/Tabs/Panel/Section/Tree/Popover/Menu/Tooltip/Dialog/ContextToolbar)
 *        → states (Default/Hover/Pressed/Active/Focused/Selected/Disabled + Canvas-selected/Editing/Dragging)
 *        → layout/interaction
 *
 * Elevation scale (audit P0-C):
 *   Flat     — canvas / inline
 *   Raised   — toolbar, ColorRow, LayerRow selected
 *   Floating — Popover, flyout menus, Color Picker
 *   Overlay  — modals, drag ghost, context menu
 *   Modal    — command palette, present
 *
 * Typography roles (semantic, not 10/12/…):
 *   T_CONTROL — inputs, fields, menus
 *   T_LABEL   — section titles, group titles
 *   T_BODY    — descriptions, empty states
 *   T_SECTION — inspector section headers
 */
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { armPopover } from "./popoverGuard";

// ── elevation tokens (CSS vars in styles.css) ────────────────────────────────
export const elevation = {
  flat: "var(--elev-flat)",
  raised: "var(--elev-raised)",
  floating: "var(--elev-floating)",
  overlay: "var(--elev-overlay)",
  modal: "var(--elev-modal)",
} as const;

// ── semantic type ───────────────────────────────────────────────────────────
export const type = {
  control: "var(--t-control)",
  label: "var(--t-label)",
  body: "var(--t-body)",
  section: "var(--t-section)",
} as const;

// ── Popover ─────────────────────────────────────────────────────────────────
/**
 * Shared floating surface. Every popover/menu/dialog in X-Native must use this
 * so radius/border/shadow/padding/close-on-outside/Escape/focus are identical.
 *
 * Anchored to a DOMRect (swatch row). Flips above if near viewport bottom.
 */
export function XPopover({
  anchor,
  title,
  onClose,
  children,
  width = 248,
  ariaLabel,
}: {
  anchor: DOMRect;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(anchor.left - width, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(anchor.top, window.innerHeight - 520)),
  }));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top = anchor.bottom + 6;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 6);
    const left = Math.max(8, Math.min(anchor.left - r.width - 10, window.innerWidth - r.width - 8));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".x-popover") && !t.closest(".color-row") && !t.closest(".fill-pop")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    const disarm = armPopover();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      disarm();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="x-popover"
      role="dialog"
      aria-label={ariaLabel ?? title ?? "Popover"}
      style={{ left: pos.left, top: pos.top, width }}
    >
      {title && (
        <div className="x-popover-head">
          <span className="x-popover-title">{title}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x-mark" size={14} />
          </button>
        </div>
      )}
      <div className="x-popover-body">{children}</div>
    </div>,
    document.body,
  );
}

// ── PropertyField ───────────────────────────────────────────────────────────
// Consistent label + input surface for inspector numeric/enum fields.
// Replaces ad-hoc <Field> variations with one spacing/typography/border.
export function PropertyField({
  label,
  icon,
  children,
  hint,
  disabled,
}: {
  label?: string;
  icon?: string;
  children: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`x-field${disabled ? " disabled" : ""}`} data-pname={icon ?? label}>
      {icon ? <Icon name={icon} size={14} /> : label ? <label className="x-field-label">{label}</label> : null}
      <div className="x-field-input">{children}</div>
      {hint && <span className="x-field-hint">{hint}</span>}
    </div>
  );
}

// ── Section (shared) — identical to inspector's but from design system ──────
export function XSection({
  title,
  actions,
  defaultOpen = true,
  storageKey,
  children,
}: {
  title: string;
  actions?: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const key = storageKey ?? `xsec:${title}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem("x-sections");
      if (raw) {
        const m = JSON.parse(raw) as Record<string, boolean>;
        if (key in m) setOpen(m[key]);
      }
    } catch {}
  }, [key]);
  const toggle = () => {
    setOpen((v) => {
      const n = !v;
      try {
        const raw = localStorage.getItem("x-sections");
        const m = raw ? JSON.parse(raw) : {};
        localStorage.setItem("x-sections", JSON.stringify({ ...m, [key]: n }));
      } catch {}
      return n;
    });
  };
  return (
    <>
      <div className="h-row">
        <button className="sec-toggle" aria-expanded={open} onClick={toggle}>
          <Icon name={open ? "chevron" : "chevron-right"} size={12} />
          <h3>{title}</h3>
        </button>
        {actions}
      </div>
      {open && children}
    </>
  );
}
