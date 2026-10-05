/**
 * The font family dialog and the font-style menu.
 *
 * Behaviour and rendered output follow the reference captures (Figma): the
 * family field opens a searchable dialog — every row set in its own typeface,
 * a check on the current family, a source filter — and the style field opens
 * a two-group menu (uprights, then the italic trio). The look is ION: the
 * `.font-pop` recipe lives in the sheet on the shared tokens, and the style
 * menu reuses the `.type-menu` rhythm the blend menu already speaks.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { useEscape } from "./escape";

/** The upright weight ladder, named exactly as the codegen vocabulary. */
export const WEIGHTS: { weight: number; name: string }[] = [
  { weight: 100, name: "Thin" },
  { weight: 200, name: "Extra Light" },
  { weight: 300, name: "Light" },
  { weight: 400, name: "Regular" },
  { weight: 500, name: "Medium" },
  { weight: 600, name: "Semi Bold" },
  { weight: 700, name: "Bold" },
  { weight: 800, name: "Extra Bold" },
  { weight: 900, name: "Black" },
];

/** The italic trio the captures show (Light Italic / Italic / Bold Italic). */
const ITALICS: { weight: number; name: string }[] = [
  { weight: 300, name: "Light Italic" },
  { weight: 400, name: "Italic" },
  { weight: 700, name: "Bold Italic" },
];

/** The style field's label: "Regular", "Bold Italic", "Medium Italic"… */
export function styleName(weight: number, italic: boolean): string {
  const base = WEIGHTS.find((w) => w.weight === weight)?.name ?? String(weight);
  if (!italic) return base;
  if (weight === 400) return "Italic";
  return `${base} Italic`;
}

/** Click-outside for a portalled pop: keep clicks inside the pop or on the
 *  control that opened it, close on anything else (same contract as the
 *  fill picker). */
function useClickOutside(keepSelector: string, onClose: () => void) {
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".font-pop") || t.closest(".type-menu") || t.closest(keepSelector)) return;
      onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [keepSelector, onClose]);
}

/** Place a portalled pop under its trigger, flipping above when the panel is
 *  near the viewport bottom. Imperative geometry — the pop carries no inline
 *  style object; the one inline value in this file is a row's own typeface. */
function useAnchoredPop(ref: React.RefObject<HTMLElement | null>, anchor: { left: number; top: number }, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8));
    let top = anchor.top;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 32);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, ...deps]);
}

export type FontEntry = { name: string; system: boolean };

export function FontPicker({
  value,
  mixed,
  fonts,
  onChange,
  onClose,
  anchor,
}: {
  value: string;
  mixed?: boolean;
  fonts: FontEntry[];
  onChange: (family: string) => void;
  onClose: () => void;
  anchor: { left: number; top: number };
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [source, setSource] = useState<"all" | "built-in" | "system">("all");
  const [active, setActive] = useState(0);
  useEscape("font-picker", onClose);
  useClickOutside('[aria-label="Font family"]', onClose);
  useAnchoredPop(popRef, anchor);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return fonts
      .filter((f) => (source === "all" ? true : source === "system" ? f.system : !f.system))
      .filter((f) => !needle || f.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [fonts, q, source]);
  useLayoutEffect(() => setActive(0), [q, source]);
  useLayoutEffect(() => {
    const el = popRef.current?.querySelector<HTMLElement>(".font-pop-row.on");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, []);
  const pick = (name: string) => {
    onChange(name);
    onClose();
  };
  return createPortal(
    <div ref={popRef} className="font-pop" role="dialog" aria-label="Fonts">
      <div className="font-pop-head">
        <span className="font-pop-title">Fonts</span>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="font-pop-search">
        <Icon name="search" size={12} />
        <input
          autoFocus
          value={q}
          placeholder="Search fonts"
          aria-label="Search fonts"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, Math.max(0, list.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && list[active]) {
              e.preventDefault();
              pick(list[active].name);
            }
          }}
        />
        {q && (
          <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQ("")}>
            <Icon name="close" size={10} />
          </button>
        )}
      </div>
      <select
        className="font-pop-src"
        aria-label="Font source"
        value={source}
        onChange={(e) => setSource(e.target.value as "all" | "built-in" | "system")}
      >
        <option value="all">All fonts</option>
        <option value="built-in">Built-in fonts</option>
        <option value="system">System fonts</option>
      </select>
      <div className="font-pop-list" role="listbox" aria-label="Font families">
        {list.map((f, i) => (
          <button
            type="button"
            key={f.name}
            role="option"
            aria-selected={f.name === value && !mixed}
            className={`font-pop-row${f.name === value && !mixed ? " on" : ""}${i === active ? " active" : ""}`}
            data-value={f.name}
            style={{ fontFamily: `"${f.name}", sans-serif` }}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(f.name)}
          >
            <span className="tick">{f.name === value && !mixed && <Icon name="check" size={12} />}</span>
            {f.name}
          </button>
        ))}
        {!list.length && (
          <p className="font-pop-empty muted" role="status">
            No fonts match “{q}”.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function FontStyleMenu({
  weight,
  italic,
  onPick,
  onClose,
  anchor,
}: {
  weight: number;
  italic: boolean;
  onPick: (p: { fontWeight: number; fontStyle: "normal" | "italic" }) => void;
  onClose: () => void;
  anchor: { left: number; top: number };
}) {
  const popRef = useRef<HTMLDivElement>(null);
  useEscape("font-style", onClose);
  useClickOutside('[aria-label="Font weight"]', onClose);
  useAnchoredPop(popRef, anchor);
  const pick = (p: { fontWeight: number; fontStyle: "normal" | "italic" }) => {
    onPick(p);
    onClose();
  };
  return createPortal(
    <div ref={popRef} className="type-menu font-style-menu" role="menu" aria-label="Font style">
      {WEIGHTS.map((w) => (
        <button
          type="button"
          key={w.weight}
          role="menuitemradio"
          aria-checked={weight === w.weight && !italic}
          data-value={w.weight}
          data-italic="0"
          onClick={() => pick({ fontWeight: w.weight, fontStyle: "normal" })}
        >
          <span className="tick">{weight === w.weight && !italic && <Icon name="check" size={12} />}</span>
          {w.name}
        </button>
      ))}
      <hr />
      {ITALICS.map((w) => (
        <button
          type="button"
          key={w.weight}
          role="menuitemradio"
          aria-checked={weight === w.weight && italic}
          data-value={w.weight}
          data-italic="1"
          onClick={() => pick({ fontWeight: w.weight, fontStyle: "italic" })}
        >
          <span className="tick">{weight === w.weight && italic && <Icon name="check" size={12} />}</span>
          {w.name}
        </button>
      ))}
    </div>,
    document.body,
  );
}
