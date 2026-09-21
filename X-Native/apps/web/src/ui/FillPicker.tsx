import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import {
  armEyedrop,
  BLENDS,
  COLOR_PRESETS,
  eyedropArmed,
  FILL_TYPES,
  hsvToRgb,
  justEyedropped,
  parseHex,
  rgbToHsv,
  toHex,
  type FillType,
} from "./color";

export interface FillValue {
  color: string;
  opacity: number;
  type: FillType;
  second: string;
  blend: string;
}

export function FillPicker({
  title,
  value,
  recents,
  anchor,
  onChange,
  onClose,
}: {
  title: string;
  value: FillValue;
  recents: string[];
  anchor: DOMRect;
  onChange: (v: FillValue) => void;
  onClose: () => void;
}) {
  const { r, g, b } = parseHex(value.color);
  const init = rgbToHsv(r, g, b);
  const [hsv, setHsv] = useState(init);
  const [hex, setHex] = useState(value.color.replace("#", "").slice(0, 6).toUpperCase());
  const [model, setModel] = useState<"hex" | "rgb">("hex");
  const [typeOpen, setTypeOpen] = useState(false);
  const [blendOpen, setBlendOpen] = useState(false);
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const op = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (eyedropArmed() || justEyedropped()) return;
      if (!t.closest(".fill-pop") && !t.closest(".color-row")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        armEyedrop((c) => applyRgb(...hexToRgb(c)));
      }
    };
    window.addEventListener("mousedown", on);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", on);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const applyRgb = (rr: number, gg: number, bb: number, next?: Partial<FillValue>) => {
    const color = toHex(rr, gg, bb);
    setHex(color.slice(1).toUpperCase());
    setHsv(rgbToHsv(rr, gg, bb));
    onChange({ ...value, color, ...next });
  };

  const applyHsv = (h: number, s: number, v: number) => {
    const rgb = hsvToRgb(h, s, v);
    setHsv({ h, s, v });
    applyRgb(rgb.r, rgb.g, rgb.b);
  };

  const drag = (
    el: HTMLDivElement | null,
    e: React.PointerEvent,
    fn: (x: number, y: number, r: DOMRect) => void,
  ) => {
    if (!el) return;
    const go = (ev: PointerEvent) => fn(ev.clientX, ev.clientY, el.getBoundingClientRect());
    go(e.nativeEvent);
    const up = () => {
      window.removeEventListener("pointermove", go);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  };

  const hueCss = `hsl(${hsv.h} 100% 50%)`;
  const left = Math.max(8, Math.min(anchor.left - 248, window.innerWidth - 256));
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 420));
  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
  const docs = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...recents, ...COLOR_PRESETS]) {
      const k = c.toLowerCase().slice(0, 7);
      if (k.length < 7 || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out.slice(0, 16);
  }, [recents]);

  return createPortal(
    <div className="fill-pop" style={{ left, top }} role="dialog" aria-label={title}>
      <div className="fill-head">
        <button className="type-btn" onClick={() => setTypeOpen((v) => !v)}>
          {FILL_TYPES.find((t) => t.id === value.type)?.label ?? "Solid"}
          <Icon name="chevron" size={12} />
        </button>
        {typeOpen && (
          <div className="type-menu">
            {FILL_TYPES.map((t) => (
              <button
                key={t.id}
                className={value.type === t.id ? "on" : ""}
                onClick={() => {
                  onChange({ ...value, type: t.id });
                  setTypeOpen(false);
                }}
              >
                {t.label}
                {value.type === t.id && <span className="sc">✓</span>}
              </button>
            ))}
          </div>
        )}
        <button
          className="icon-btn"
          title="Eyedropper (I)"
          onClick={() => armEyedrop((c) => applyRgb(...hexToRgb(c)))}
        >
          <Icon name="eyedropper" size={14} />
        </button>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <Icon name="x-mark" size={14} />
        </button>
      </div>

      <div
        className="sv"
        ref={sv}
        style={{ background: hueCss }}
        onPointerDown={(e) =>
          drag(sv.current, e, (x, y, box) => {
            const s = Math.max(0, Math.min(1, (x - box.left) / box.width));
            const v = Math.max(0, Math.min(1, 1 - (y - box.top) / box.height));
            applyHsv(hsv.h, s, v);
          })
        }
      >
        <i
          className="sv-cursor"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: toHex(rgb.r, rgb.g, rgb.b),
          }}
        />
      </div>

      <div
        className="hue"
        ref={hue}
        onPointerDown={(e) =>
          drag(hue.current, e, (x, _, box) => {
            const h = Math.max(0, Math.min(360, ((x - box.left) / box.width) * 360));
            applyHsv(h, hsv.s, hsv.v);
          })
        }
      >
        <i className="hue-mark" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>

      <div
        className="op-track"
        ref={op}
        style={{
          background: `linear-gradient(90deg, transparent, ${toHex(rgb.r, rgb.g, rgb.b)})`,
        }}
        onPointerDown={(e) =>
          drag(op.current, e, (x, _, box) => {
            const o = Math.round(Math.max(0, Math.min(1, (x - box.left) / box.width)) * 100);
            onChange({ ...value, opacity: o });
          })
        }
      >
        <i className="hue-mark" style={{ left: `${value.opacity}%` }} />
      </div>

      <div className="hex-row">
        <span className="swatch" style={{ background: toHex(rgb.r, rgb.g, rgb.b) }} />
        <button className="model" onClick={() => setModel((m) => (m === "hex" ? "rgb" : "hex"))}>
          {model.toUpperCase()}
        </button>
        {model === "hex" ? (
          <input
            className="hex"
            value={hex}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
              setHex(v);
              if (v.length === 6) applyRgb(...hexToRgb("#" + v));
            }}
          />
        ) : (
          <span className="rgb-read">
            {(["r", "g", "b"] as const).map((ch) => (
              <input
                key={ch}
                className="op"
                value={rgb[ch]}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isNaN(n)) return;
                  const next = { ...rgb, [ch]: Math.max(0, Math.min(255, n)) };
                  applyRgb(next.r, next.g, next.b);
                }}
              />
            ))}
          </span>
        )}
        <input
          className="op"
          value={`${Math.round(value.opacity)}%`}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isNaN(n)) onChange({ ...value, opacity: Math.max(0, Math.min(100, n)) });
          }}
        />
      </div>

      {(value.type === "linear" || value.type === "radial" || value.type === "angular" || value.type === "diamond") && (
        <div className="hex-row">
          <span className="swatch" style={{ background: value.second }} />
          <span className="muted-inline">Stop 2</span>
          <input
            className="hex"
            value={value.second.replace("#", "")}
            onChange={(e) => onChange({ ...value, second: "#" + e.target.value.replace("#", "") })}
          />
        </div>
      )}

      <div className="swatch-grid">
        {docs.map((c) => (
          <button
            key={c}
            className={`chip${c.toLowerCase() === value.color.toLowerCase() ? " on" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => applyRgb(...hexToRgb(c))}
          />
        ))}
      </div>

      <button className="blend-row" onClick={() => setBlendOpen((v) => !v)}>
        Apply blend mode
        <span>
          {value.blend}
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {blendOpen && (
        <div className="type-menu blend-menu">
          {BLENDS.map((b) => (
            <button
              key={b}
              className={value.blend === b ? "on" : ""}
              onClick={() => {
                onChange({ ...value, blend: b });
                setBlendOpen(false);
              }}
            >
              {b}
              {value.blend === b && <span className="sc">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function hexToRgb(c: string): [number, number, number] {
  const { r, g, b } = parseHex(c);
  return [r, g, b];
}
