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
 *   Floating — Popover, flyout menus, Color Picker, Context Toolbar
 *   Overlay  — modals, drag ghost, context menu
 *   Modal    — command palette, present, dialogs
 *
 * Typography roles (semantic, not 10/12/…):
 *   T_CONTROL — inputs, fields, menus
 *   T_LABEL   — section titles, group titles
 *   T_BODY    — descriptions, empty states
 *   T_SECTION — inspector section headers
 */
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { armPopover } from "./popoverGuard";
import { evalField } from "./fieldExpr";
import type { XNode } from "../engine/types";

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

// ── Button ──────────────────────────────────────────────────────────────────
export interface XButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "icon";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconSize?: number;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  ariaLabel?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function XButton({
  variant = "secondary",
  size = "md",
  icon,
  iconSize,
  disabled = false,
  active = false,
  title,
  ariaLabel,
  onClick,
  children,
  className = "",
  style,
}: XButtonProps) {
  const isIconOnly = variant === "icon" || (!children && !!icon);
  const sizeClass = `x-btn-${size}`;
  const variantClass = isIconOnly ? "x-btn-ghost x-btn-icon" : `x-btn-${variant}`;
  const activeClass = active ? " on" : "";
  const isSz = iconSize ?? (size === "sm" ? 12 : size === "lg" ? 16 : 14);

  return (
    <button
      className={`x-btn ${variantClass} ${sizeClass}${activeClass} ${className}`}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel ?? title}
      onClick={onClick}
      style={style}
    >
      {icon && <Icon name={icon} size={isSz} />}
      {children}
    </button>
  );
}

// ── Input ───────────────────────────────────────────────────────────────────
export interface XInputProps {
  value: string;
  onChange: (val: string) => void;
  onCommit?: (val: string) => void;
  placeholder?: string;
  icon?: IconName;
  suffix?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function XInput({
  value,
  onChange,
  onCommit,
  placeholder,
  icon,
  suffix,
  disabled = false,
  ariaLabel,
  className = "",
  style,
}: XInputProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className={`x-input-wrap ${className}`} style={style}>
      {icon && <Icon name={icon} size={14} />}
      <input
        className="x-input"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => onCommit?.(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
            onCommit?.(draft);
          }
        }}
      />
      {suffix && <span className="x-input-suffix">{suffix}</span>}
    </div>
  );
}

// ── Scrubbable Numeric Input ────────────────────────────────────────────────
export interface XNumericInputProps {
  value: number;
  onChange: (val: number) => void;
  label?: string;
  icon?: IconName;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
}

export function XNumericInput({
  value,
  onChange,
  label,
  icon,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  ariaLabel,
  style,
}: XNumericInputProps) {
  const [draft, setDraft] = useState<string>(() => (Number.isFinite(value) ? String(value) : "0"));
  const [focused, setFocused] = useState(false);
  const scrubStart = useRef<{ x: number; orig: number } | null>(null);

  useEffect(() => {
    if (!focused) {
      setDraft(Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0");
    }
  }, [value, focused]);

  const commit = (raw: string) => {
    const evaluated = evalField(raw, value);
    if (evaluated !== null && Number.isFinite(evaluated)) {
      let next = evaluated;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onChange(Math.round(next * 100) / 100);
      setDraft(String(Math.round(next * 100) / 100));
    } else {
      setDraft(String(Math.round(value * 100) / 100));
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    scrubStart.current = { x: e.clientX, orig: value };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!scrubStart.current) return;
    const dx = e.clientX - scrubStart.current.x;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    let next = scrubStart.current.orig + dx * step * mult;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(Math.round(next * 100) / 100);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (scrubStart.current) {
      scrubStart.current = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  return (
    <div className={`x-num-wrap${disabled ? " disabled" : ""}`} style={style}>
      {label ? (
        <span
          className="x-num-label"
          title="Drag horizontally to scrub value"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {label}
        </span>
      ) : icon ? (
        <span
          className="x-num-label"
          title="Drag horizontally to scrub value"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <Icon name={icon} size={12} />
        </span>
      ) : null}
      <input
        className="x-num-input"
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const delta = e.shiftKey ? 10 : 1;
            const next = value + delta;
            onChange(max !== undefined ? Math.min(max, next) : next);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const delta = e.shiftKey ? 10 : 1;
            const next = value - delta;
            onChange(min !== undefined ? Math.max(min, next) : next);
          }
        }}
      />
      {suffix && <span className="x-input-suffix">{suffix}</span>}
    </div>
  );
}

// ── Select ──────────────────────────────────────────────────────────────────
export interface XSelectOption {
  value: string;
  label: string;
  icon?: IconName;
}

export function XSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  style,
}: {
  value: string;
  options: XSelectOption[];
  onChange: (val: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
}) {
  return (
    <select
      className="x-select"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      style={style}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ── Segmented Control ───────────────────────────────────────────────────────
export function XSegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label?: string; icon?: IconName; title?: string }[];
  onChange: (val: string) => void;
}) {
  return (
    <div className="x-seg">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`x-seg-btn${value === opt.value ? " on" : ""}`}
          title={opt.title ?? opt.label}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
        >
          {opt.icon && <Icon name={opt.icon} size={14} />}
          {opt.label && <span>{opt.label}</span>}
        </button>
      ))}
    </div>
  );
}

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
  }, [anchor, width]);

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
  icon?: IconName;
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
          <h2>{title}</h2>
        </button>
        {actions}
      </div>
      {open && children}
    </>
  );
}

// ── Modal Dialog ────────────────────────────────────────────────────────────
export function XDialog({
  title,
  onClose,
  children,
  footer,
  width = 460,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="x-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="x-dialog" style={{ width }} role="dialog" aria-label={title}>
        <div className="x-dialog-head">
          <span className="x-dialog-title">{title}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x-mark" size={14} />
          </button>
        </div>
        <div className="x-dialog-body">{children}</div>
        {footer && <div className="x-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ── Context Toolbar (Audit Section 18) ──────────────────────────────────────
/**
 * Contextual Floating Canvas Toolbar.
 * Floats near the selection bounding box on canvas to provide instant,
 * 1-click access to the most frequent operations for the active selection type.
 */
export function ContextToolbar({
  x,
  y,
  node,
  multi,
  onAutoLayout,
  onAlign,
  onGroup,
  onComponent,
  onDuplicate,
  onDelete,
  onFlipH,
  onFlipV,
}: {
  x: number;
  y: number;
  node?: XNode | null;
  multi?: boolean;
  onAutoLayout?: () => void;
  onAlign?: (mode: string) => void;
  onGroup?: () => void;
  onComponent?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onFlipH?: () => void;
  onFlipV?: () => void;
}) {
  const isFrame = node?.kind === "frame" || node?.isComponent || node?.componentId;
  const isText = node?.kind === "text";
  const isVector = node?.kind === "vector" || node?.kind === "boolean";

  return (
    <div
      className="x-context-toolbar"
      style={{ left: Math.max(12, Math.min(x, window.innerWidth - 380)), top: y }}
    >
      <span className="kind-badge">
        {multi ? "Selection" : isFrame ? "Frame" : isText ? "Text" : isVector ? "Vector" : node?.kind ?? "Layer"}
      </span>
      <div className="sep" />

      {/* Auto Layout toggle: offered for any selection, like ⇧A — a lone
          rectangle wraps in a frame just as well as a frame takes layout. */}
      {onAutoLayout && (node || multi) && (
        <button
          className="icon-btn"
          title="Auto Layout (⇧A)"
          onClick={onAutoLayout}
        >
          <Icon name="layout-h" size={14} />
        </button>
      )}

      {/* Align actions */}
      {onAlign && (
        <>
          <button
            className="icon-btn"
            title="Align Center (⌥H)"
            onClick={() => onAlign("align-hcenter")}
          >
            <Icon name="align-hcenter" size={14} />
          </button>
          <button
            className="icon-btn"
            title="Align Middle (⌥V)"
            onClick={() => onAlign("align-vcenter")}
          >
            <Icon name="align-vcenter" size={14} />
          </button>
        </>
      )}

      {/* Group */}
      {onGroup && (
        <button
          className="icon-btn"
          title="Group (⌘G)"
          onClick={onGroup}
        >
          <Icon name="group" size={14} />
        </button>
      )}

      {/* Component */}
      {onComponent && !node?.isComponent && (
        <button
          className="icon-btn"
          title="Create Component (⌥⌘K)"
          onClick={onComponent}
        >
          <Icon name="component" size={14} />
        </button>
      )}

      {/* Flip */}
      {onFlipH && (
        <button
          className="icon-btn"
          title="Flip Horizontal (⇧H)"
          onClick={onFlipH}
        >
          <Icon name="flip-h" size={14} />
        </button>
      )}
      {onFlipV && (
        <button
          className="icon-btn"
          title="Flip Vertical (⇧V)"
          onClick={onFlipV}
        >
          <Icon name="flip-v" size={14} />
        </button>
      )}

      <div className="sep" />

      {/* Duplicate */}
      {onDuplicate && (
        <button
          className="icon-btn"
          title="Duplicate (⌘D)"
          onClick={onDuplicate}
        >
          <Icon name="copy" size={14} />
        </button>
      )}

      {/* Delete */}
      {onDelete && (
        <button
          className="icon-btn"
          title="Delete (⌫)"
          onClick={onDelete}
        >
          <Icon name="trash" size={14} />
        </button>
      )}
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────
export function XTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          className="tab"
          aria-current={active === t.id}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count"> {t.count}</span>}
        </button>
      ))}
    </div>
  );
}
