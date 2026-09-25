import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GradientStop } from "../engine/types";
import { Icon, caretSize } from "./icons";
import { useRestoreFocus } from "./a11y";
import {
  armEyedrop,
  BLENDS,
  COLOR_MODELS,
  COLOR_PRESETS,
  CONTRAST_KINDS,
  contrastRatio,
  contrastTarget,
  eyedropArmed,
  FILL_TYPES,
  handlesForFill,
  hslToRgb,
  hsvToRgb,
  IMAGE_ADJS,
  IMAGE_FITS,
  isNone,
  justEyedropped,
  nearestAccessible,
  nextColorModel,
  parseCssColor,
  parseHex,
  rgbToHsl,
  rgbToHsv,
  toCss,
  toHex,
  type ColorModel,
  type FillType,
  type ImageFit,
} from "./color";
import { rememberImage } from "../engine/assets";
import { armPopover } from "./popoverGuard";

export interface FillValue {
  color: string;
  opacity: number;
  type: FillType;
  second: string;
  blend: string;
  image?: string;
  imageFit?: ImageFit;
  imageRot?: number;
  imageExposure?: number;
  imageContrast?: number;
  imageSaturation?: number;
  imageTemperature?: number;
  imageTint?: number;
  imageHighlights?: number;
  imageShadows?: number;
  gx?: number;
  gy?: number;
  hx?: number;
  hy?: number;
  /** Multi-stop ramp; empty falls back to the `color`/`second` pair. */
  stops?: GradientStop[];
}

/** Resolve the ramp a gradient should show, materialising the legacy pair. */
function rampOf(v: FillValue): GradientStop[] {
  if (v.stops && v.stops.length >= 2) return [...v.stops].sort((a, b) => a.position - b.position);
  return [
    { color: v.color, position: 0 },
    { color: v.second, position: 1 },
  ];
}

export function FillPicker({
  title,
  value,
  recents,
  anchor,
  background,
  largeText,
  onChange,
  onClose,
}: {
  title: string;
  value: FillValue;
  recents: string[];
  anchor: DOMRect;
  /** What the colour is painted over, resolved from the layer's own ancestry so
   *  the check means something on the canvas rather than only against white. */
  background?: string;
  /** WCAG's large-text exemption: 24px, or 19px and bold. */
  largeText?: boolean;
  onChange: (v: FillValue) => void;
  onClose: () => void;
}) {
  useRestoreFocus();
  const { r, g, b } = parseHex(value.color);
  const init = rgbToHsv(r, g, b);
  const [hsv, setHsv] = useState(init);
  const [hex, setHex] = useState(value.color.replace("#", "").slice(0, 8).toUpperCase());
  const [css, setCss] = useState(toCss(r, g, b, value.opacity / 100));
  const [model, setModel] = useState<ColorModel>("hex");
  const [a11y, setA11y] = useState(false);
  const [bgOverride, setBgOverride] = useState<string | null>(null);
  const [a11yKind, setA11yKind] = useState<"auto" | "large" | "normal" | "graphics">("auto");
  const [typeOpen, setTypeOpen] = useState(false);
  const [blendOpen, setBlendOpen] = useState(false);
  /** Index of the gradient stop the colour area is currently editing. */
  const [stopIdx, setStopIdx] = useState(0);
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const op = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = parseHex(value.color);
    setHsv(rgbToHsv(next.r, next.g, next.b));
    setHex(value.color.replace("#", "").slice(0, 8).toUpperCase());
    setCss(toCss(next.r, next.g, next.b, value.opacity / 100));
  }, [value.color, value.opacity]);

  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (eyedropArmed() || justEyedropped()) return;
      if (!t.closest(".fill-pop") && !t.closest(".color-row")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && !typing) {
        e.preventDefault();
        setModel((m) => nextColorModel(m));
      }
      const drop =
        (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey && !typing) ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !typing);
      if (drop) {
        e.preventDefault();
        armEyedrop((c) => applyRgb(...hexToRgb(c)));
      }
    };
    window.addEventListener("mousedown", on);
    window.addEventListener("keydown", key);
    // Escape closes the picker; it should not also drop the selection behind it.
    const disarm = armPopover();
    return () => {
      window.removeEventListener("mousedown", on);
      window.removeEventListener("keydown", key);
      disarm();
    };
  }, [onClose, value]);

  const applyRgb = (rr: number, gg: number, bb: number, next?: Partial<FillValue>) => {
    const color = toHex(rr, gg, bb);
    setHex(color.slice(1).toUpperCase());
    setHsv(rgbToHsv(rr, gg, bb));
    const op = next?.opacity ?? value.opacity;
    setCss(toCss(rr, gg, bb, op / 100));
    const isGradient =
      value.type === "linear" ||
      value.type === "radial" ||
      value.type === "angular" ||
      value.type === "diamond";
    if (isGradient) {
      // The colour area edits whichever stop is selected, not just `color`.
      const ramp = rampOf(value);
      const i = Math.min(stopIdx, ramp.length - 1);
      const stops = ramp.map((s, k) => (k === i ? { ...s, color } : s));
      onChange({
        ...value,
        stops,
        // Keep the legacy pair in sync so older render paths stay correct.
        color: stops[0].color,
        second: stops[stops.length - 1].color,
        ...next,
      });
      return;
    }
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
  /* Contrast, measured the way WCAG defines it. The layer's own background is
     only ever an approximation of what sits behind the fill, so the field is
     editable; the fill's opacity is composited in because a 40% fill is not the
     colour it looks like. */
  const bg = bgOverride ?? (background && background.length >= 7 ? background.slice(0, 7) : "#ffffff");
  const fg = (() => {
    const c = parseHex(value.color);
    const g0 = parseHex(bg);
    const k = Math.max(0, Math.min(1, value.opacity / 100));
    return toHex(
      Math.round(c.r * k + g0.r * (1 - k)),
      Math.round(c.g * k + g0.g * (1 - k)),
      Math.round(c.b * k + g0.b * (1 - k)),
    );
  })();
  const ratio = contrastRatio(fg, bg);
  const resolvedKind: "large" | "normal" | "graphics" =
    a11yKind === "auto" ? (largeText ? "large" : "normal") : a11yKind;
  const targetAA = contrastTarget(resolvedKind, "AA");
  const targetAAA = contrastTarget(resolvedKind, "AAA");
  const passAA = ratio + 1e-6 >= targetAA;
  const passAAA = ratio + 1e-6 >= targetAAA;
  const hasAAA = resolvedKind !== "graphics";
  // Anchor to the row that opened us — picker appears beside the swatch,
  // never 400px away — and flip above when the row sits near the bottom edge.
  // The height is measured after paint because the popover grows with gradient
  // and image controls.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(anchor.left - 248, window.innerWidth - 256)),
    top: Math.max(8, Math.min(anchor.top, window.innerHeight - 520)),
  }));
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top = anchor.bottom + 6;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 6);
    const left = Math.max(8, Math.min(anchor.left - r.width - 10, window.innerWidth - r.width - 8));
    setPos({ left, top });
  }, [anchor]);
  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const image = value.type === "image";
  const gradient =
    value.type === "linear" || value.type === "radial" || value.type === "angular" || value.type === "diamond";
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

  const setType = (id: FillType) => {
    const handles = handlesForFill(id);
    const color = id !== "image" && isNone(value.color) ? "#d9d9d9" : value.color;
    onChange({
      ...value,
      type: id,
      color,
      ...(handles
        ? { gx: handles.fillGX, gy: handles.fillGY, hx: handles.fillHX, hy: handles.fillHY }
        : {}),
    });
    setTypeOpen(false);
  };

  const rotHandles = () => {
    const gx = value.gx ?? 0.5;
    const gy = value.gy ?? 0;
    const hx = value.hx ?? 0.5;
    const hy = value.hy ?? 1;
    onChange({
      ...value,
      gx: 0.5 - (gy - 0.5),
      gy: 0.5 + (gx - 0.5),
      hx: 0.5 - (hy - 0.5),
      hy: 0.5 + (hx - 0.5),
    });
  };

  const modelFields = () => {
    if (model === "hex") {
      return (
        <input
          className="hex"
          value={hex}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
            setHex(v);
            if (v.length === 6 || v.length === 3 || v.length === 8 || v.length === 4) {
              const p = parseHex("#" + v);
              applyRgb(p.r, p.g, p.b, v.length === 8 || v.length === 4 ? { opacity: Math.round(p.a * 100) } : undefined);
            }
          }}
        />
      );
    }
    if (model === "css") {
      return (
        <input
          className="hex css-field"
          value={css}
          spellCheck={false}
          onChange={(e) => {
            setCss(e.target.value);
            const p = parseCssColor(e.target.value);
            if (p) applyRgb(p.r, p.g, p.b, { opacity: Math.round(p.a * 100) });
          }}
        />
      );
    }
    if (model === "rgb") {
      return (
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
      );
    }
    if (model === "hsl") {
      const vals = [
        { k: "h", v: Math.round(hsl.h), min: 0, max: 360 },
        { k: "s", v: Math.round(hsl.s * 100), min: 0, max: 100 },
        { k: "l", v: Math.round(hsl.l * 100), min: 0, max: 100 },
      ] as const;
      return (
        <span className="rgb-read">
          {vals.map((f) => (
            <input
              key={f.k}
              className="op"
              value={f.v}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (Number.isNaN(n)) return;
                const next = {
                  h: f.k === "h" ? Math.max(0, Math.min(360, n)) : hsl.h,
                  s: f.k === "s" ? Math.max(0, Math.min(100, n)) / 100 : hsl.s,
                  l: f.k === "l" ? Math.max(0, Math.min(100, n)) / 100 : hsl.l,
                };
                const rgbv = hslToRgb(next.h, next.s, next.l);
                applyRgb(rgbv.r, rgbv.g, rgbv.b);
              }}
            />
          ))}
        </span>
      );
    }
    const vals = [
      { k: "h", v: Math.round(hsv.h), min: 0, max: 360 },
      { k: "s", v: Math.round(hsv.s * 100), min: 0, max: 100 },
      { k: "b", v: Math.round(hsv.v * 100), min: 0, max: 100 },
    ] as const;
    return (
      <span className="rgb-read">
        {vals.map((f) => (
          <input
            key={f.k}
            className="op"
            value={f.v}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isNaN(n)) return;
              applyHsv(
                f.k === "h" ? Math.max(0, Math.min(360, n)) : hsv.h,
                f.k === "s" ? Math.max(0, Math.min(100, n)) / 100 : hsv.s,
                f.k === "b" ? Math.max(0, Math.min(100, n)) / 100 : hsv.v,
              );
            }}
          />
        ))}
      </span>
    );
  };

  return createPortal(
    <div ref={popRef} className="fill-pop" style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={title}>
      <div className="fill-head">
        <button className="type-btn" onClick={() => setTypeOpen((v) => !v)}>
          {FILL_TYPES.find((t) => t.id === value.type)?.label ?? "Solid"}
          <Icon name="chevron" size={caretSize()} />
        </button>
        {typeOpen && (
          <div className="type-menu">
            {FILL_TYPES.map((t) => (
              <button
                key={t.id}
                className={value.type === t.id ? "on" : ""}
                onClick={() => setType(t.id)}
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

      {!image && (
        <>
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
        </>
      )}

      <div
        className="op-track"
        ref={op}
        style={{
          background: `linear-gradient(90deg, transparent, ${toHex(rgb.r, rgb.g, rgb.b)})`,
        }}
        onPointerDown={(e) =>
          drag(op.current, e, (x, _, box) => {
            const o = Math.round(Math.max(0, Math.min(1, (x - box.left) / box.width)) * 100);
            setCss(toCss(rgb.r, rgb.g, rgb.b, o / 100));
            onChange({ ...value, opacity: o });
          })
        }
      >
        <i className="hue-mark" style={{ left: `${value.opacity}%` }} />
      </div>

      {!image && (
        <div className="hex-row">
          <span className="swatch" style={{ background: toHex(rgb.r, rgb.g, rgb.b) }} />
          <button
            className="model"
            title="Color model (Tab)"
            onClick={() => setModel((m) => nextColorModel(m))}
          >
            {COLOR_MODELS.find((m) => m.id === model)?.label ?? "Hex"}
          </button>
          {modelFields()}
          <input
            className="op"
            value={`${Math.round(value.opacity)}%`}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (!Number.isNaN(n)) {
                const o = Math.max(0, Math.min(100, n));
                setCss(toCss(rgb.r, rgb.g, rgb.b, o / 100));
                onChange({ ...value, opacity: o });
              }
            }}
          />
        </div>
      )}

      {!image && (
        <div className="a11y-row">
          <button
            className={`blend-row${a11y ? " on" : ""}`}
            aria-expanded={a11y}
            onClick={() => setA11y((v) => !v)}
          >
            <Icon name="info" size={12} /> Check color contrast
          </button>
          {a11y && (
            <div className="a11y-body">
              <div className="a11y-bg">
                <span className="swatch" style={{ background: bg }} />
                <input
                  aria-label="Background color"
                  title="The color behind this fill · type a hex to compare against something else"
                  value={bg.replace("#", "").toUpperCase()}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (/^[0-9a-fA-F]{6}$/.test(raw)) setBgOverride(`#${raw.toLowerCase()}`);
                  }}
                />
                {bgOverride && (
                  <button
                    className="mini"
                    title="Back to the background this layer actually sits on"
                    onClick={() => setBgOverride(null)}
                  >
                    <Icon name="reset" size={12} />
                  </button>
                )}
                <select
                  aria-label="Contrast category"
                  value={a11yKind}
                  onChange={(e) => setA11yKind(e.target.value as typeof a11yKind)}
                >
                  {CONTRAST_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="a11y-result">
                <strong>{ratio.toFixed(2)}:1</strong>
                <span className={`a11y-badge${passAA ? " ok" : " bad"}`} title={`AA · ${targetAA}:1`}>
                  AA <Icon name={passAA ? "check" : "x-mark"} size={12} />
                </span>
                {hasAAA && (
                  <span className={`a11y-badge${passAAA ? " ok" : " bad"}`} title={`AAA · ${targetAAA}:1`}>
                    AAA <Icon name={passAAA ? "check" : "x-mark"} size={12} />
                  </span>
                )}
                {!passAA && (
                  <button
                    className="mini a11y-fix"
                    title={`Move to the nearest color that clears ${targetAA}:1, hue and saturation intact`}
                    onClick={() => onChange({ ...value, color: nearestAccessible(fg, bg, targetAA) })}
                  >
                    Fix
                  </button>
                )}
              </div>
              <p className="a11y-note">
                {resolvedKind === "large"
                  ? "Large text · 24px, or 19px and bold — needs 3:1."
                  : resolvedKind === "graphics"
                    ? "Graphics and UI components need 3:1."
                    : "Normal text needs 4.5:1."}{" "}
                Measured against the {bgOverride ? "typed" : "layer's own"} background, with this fill's
                opacity applied.
              </p>
            </div>
          )}
        </div>
      )}

      {image && (
        <div className="img-fill">
          {value.image ? (
            <img className="img-preview" src={value.image} alt="" />
          ) : (
            <div className="img-preview empty-img">No image</div>
          )}
          <button className="blend-row" onClick={() => fileRef.current?.click()}>
            {value.image ? "Replace image" : "Choose image"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => {
                const src = String(reader.result);
                rememberImage(src);
                onChange({ ...value, type: "image", image: src });
              };
              reader.readAsDataURL(f);
            }}
          />
          <div className="img-modes">
            {IMAGE_FITS.map((f) => (
              <button
                key={f.id}
                className={(value.imageFit || "fill") === f.id ? "on" : ""}
                onClick={() => onChange({ ...value, imageFit: f.id })}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            className="blend-row"
            title="Rotate fill 90°"
            onClick={() => onChange({ ...value, imageRot: ((value.imageRot || 0) + 90) % 360 })}
          >
            Rotate 90°
            <span>{value.imageRot || 0}°</span>
          </button>
          <div className="img-adjs">
            {IMAGE_ADJS.map((a) => {
              const v = value[a.key] || 0;
              return (
                <label className="adj-row" key={a.key}>
                  <span>{a.label}</span>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    value={v}
                    onChange={(e) =>
                      onChange({ ...value, [a.key]: parseInt(e.target.value, 10) } as FillValue)
                    }
                  />
                  <em>{v}</em>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {gradient && (
        <GradientStops
          value={value}
          selected={stopIdx}
          onSelect={setStopIdx}
          onChange={onChange}
          onRotate={rotHandles}
        />
      )}

      {!image && (
        <div className="swatch-grid">
          {docs.map((c) => (
            <button
              key={c}
              className={`chip${c.toLowerCase() === value.color.toLowerCase().slice(0, 7) ? " on" : ""}`}
              style={{ background: c }}
              title={c}
              onClick={() => applyRgb(...hexToRgb(c))}
            />
          ))}
        </div>
      )}

      <button className="blend-row" onClick={() => setBlendOpen((v) => !v)}>
        Apply blend mode
        <span>
          {value.blend}
          <Icon name="chevron" size={caretSize()} />
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

/**
 * Gradient ramp editor: a preview bar with draggable stop handles,
 * click-empty-space to insert, double-click / Delete to remove.
 */
function GradientStops({
  value,
  selected,
  onSelect,
  onChange,
  onRotate,
}: {
  value: FillValue;
  selected: number;
  onSelect: (i: number) => void;
  onChange: (v: FillValue) => void;
  onRotate: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const stops = rampOf(value);
  const idx = Math.min(selected, stops.length - 1);

  /** Write a ramp back, keeping the legacy first/last pair in sync. */
  const commit = (next: GradientStop[]) => {
    const sorted = [...next].sort((a, b) => a.position - b.position);
    onChange({
      ...value,
      stops: sorted,
      color: sorted[0].color,
      second: sorted[sorted.length - 1].color,
    });
    return sorted;
  };

  const css = `linear-gradient(to right, ${stops
    .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
    .join(", ")})`;

  const dragStop = (i: number, e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(i);
    const el = bar.current;
    if (!el) return;
    const id = stops[i];
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
      const next = stops.map((s) => (s === id ? { ...s, position: t } : s));
      const sorted = commit(next);
      onSelect(sorted.findIndex((s) => s.color === id.color && s.position === t));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="grad-editor">
      <div
        className="grad-bar"
        ref={bar}
        style={{ background: css }}
        onPointerDown={(e) => {
          // Clicking the bar inserts a stop sampled from the ramp at that point.
          const r = e.currentTarget.getBoundingClientRect();
          const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
          let after = stops.findIndex((s) => s.position > t);
          if (after < 0) after = stops.length;
          const before = Math.max(0, after - 1);
          const sorted = commit([...stops, { color: stops[before].color, position: t }]);
          onSelect(sorted.findIndex((s) => s.position === t));
        }}
      >
        {stops.map((s, i) => (
          <button
            key={`${i}-${s.position}`}
            className={`grad-stop${i === idx ? " on" : ""}`}
            style={{ left: `${s.position * 100}%`, background: s.color }}
            title={`${s.color} · ${Math.round(s.position * 100)}%`}
            onPointerDown={(e) => dragStop(i, e)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (stops.length <= 2) return;
              commit(stops.filter((_, k) => k !== i));
              onSelect(Math.max(0, i - 1));
            }}
          />
        ))}
      </div>
      <div className="hex-row grad-row">
        <span className="swatch" style={{ background: stops[idx].color }} />
        <span className="muted-inline">Stop {idx + 1}</span>
        <input
          className="hex"
          value={stops[idx].color.replace("#", "").slice(0, 8).toUpperCase()}
          spellCheck={false}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
            const color =
              raw.length === 3 || raw.length === 4 || raw.length === 6 || raw.length === 8
                ? (() => {
                    const p = parseHex("#" + raw);
                    return (
                      toHex(p.r, p.g, p.b) +
                      (raw.length === 8 || raw.length === 4
                        ? Math.round(p.a * 255).toString(16).padStart(2, "0")
                        : "")
                    );
                  })()
                : "#" + raw;
            commit(stops.map((s, k) => (k === idx ? { ...s, color } : s)));
          }}
        />
        <input
          className="hex grad-pos"
          value={Math.round(stops[idx].position * 100)}
          spellCheck={false}
          onChange={(e) => {
            const p = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
            if (isNaN(p)) return;
            commit(
              stops.map((s, k) =>
                k === idx ? { ...s, position: Math.max(0, Math.min(100, p)) / 100 } : s,
              ),
            );
          }}
        />
      </div>
      <div className="grad-actions">
        <button
          className="icon-btn"
          title="Remove stop"
          disabled={stops.length <= 2}
          onClick={() => {
            if (stops.length <= 2) return;
            commit(stops.filter((_, k) => k !== idx));
            onSelect(Math.max(0, idx - 1));
          }}
        >
          <Icon name="trash" size={14} />
        </button>
        <button
          className="icon-btn"
          title="Reverse gradient"
          onClick={() => commit(stops.map((s) => ({ ...s, position: 1 - s.position })))}
        >
          <Icon name="flip-h" size={14} />
        </button>
        <button className="icon-btn" title="Rotate gradient" onClick={onRotate}>
          <Icon name="rotate" size={14} />
        </button>
      </div>
    </div>
  );
}
