import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  AutoLayout,
  Constraint,
  Effect,
  EffectKind,
  Engine,
  ExportFormat,
  ExportPreset,
  GridTrack,
  LayoutAlign,
  LayoutJustify,
  RightTab,
  Sizing,
  Snapshot,
  StrokeAlign,
  StrokeCap,
  StrokeJoin,
  TextAlign,
  TextAlignVertical,
  Interaction,
  ProtoDevice,
  ProtoAnim,
  ProtoEasing,
  ProtoTrigger,
  LayoutGrid,
  GridPattern,
  XNode,
} from "../engine/types";
import { collectColors, defaultEffect, find, findParent, framesOf, insideInstance, worldPos } from "../engine/memory";
import { colorUsageAll, recolorMatches, selectByColor, setOpacityMatches } from "./selectionColors";
import { evalField, hasExpression } from "./fieldExpr";
import {
  SIDES,
  parseDashPattern,
  sideWidths,
  sidesSupported,
} from "../engine/strokeModel";
import {
  canAddEffect,
  canShowBehindTransparent,
  countKind,
  effectCanBlend,
  effectCanShowBehind,
  limitMessage,
  moveEffect,
  EFFECT_LIMITS,
} from "./effectModel";
import {
  rotateAboutOrigin,
  SCALE_ANCHORS,
  SCALE_FACTORS,
  scaleMembers,
  sizeKeepingRatio,
  SCALE_LABEL,
  unionBox,
  type ScaleAnchor,
} from "./scaleModel";
import { pathToVectorNetwork, vectorNetworkToSvgPath, vertexDegree, simplifyPath, smoothPath } from "../engine/geometry";
import {
  SPACING_MODES,
  alignKey,
  widthIsMain,
  alignmentCells,
  effectiveSizing,
  hasFillChild,
  hugsCross,
  hugsMain,
  planGrid,
  isAutoGap,
  layoutKeyPatch,
  parsePaddingShorthand,
  wraps,
  type AlignCell,
} from "../engine/layout";
import { hugSize } from "./textLayout";
import { Icon, caretSize, rowIconSize } from "./icons";
import { Tooltip } from "./Tooltip";
import { copyText } from "../engine/clipboard";
import { buildPdf } from "../engine/pdf";
import { exportSvg } from "../engine/svgExport";
import { plural, toast } from "./toast";
import { armPopover } from "./popoverGuard";
import { ZOOM_STEPS, parseZoomInput, stepZoom, zoomAboutCentre, zoomLabel, zoomTo } from "./zoom";
import { addAutoLayout, removeAutoLayout, setFlow, suggestAutoLayout } from "./layoutActions";
import {
  FORMAT_CAPS,
  FORMATS,
  SCALE_PRESETS,
  exportSize,
  formatScale,
  newPreset,
  qualityValue,
  resolveSettings,
} from "./exportModel";
import { DEVICE_GROUPS, DevicePreview, deviceFor } from "./devices";
import { roundToPixel } from "./round";

/** Sketch only shows "Round to Pixel" when rounding can actually do something. */
function isFractional(n: XNode) {
  return [n.x, n.y, n.w, n.h].some((v) => !Number.isInteger(v));
}
import { FillPicker, type FillValue } from "./FillPicker";
import { BLENDS, handlesForFill, isNone, parseHex, withAlpha } from "./color";
import { ContextMenu, runMenu } from "./ContextMenu";
import {
  DEV_LANGS,
  devLangLabel,
  getDevPrefs,
  setDevPrefs,
  subscribeDevPrefs,
  type DevFormat,
  type DevUnit,
} from "./devPrefs";

export function RightPanel({
  engine,
  snap,
  onPresent,
  onShare,
  exportOpen,
  onCloseExport,
}: {
  engine: Engine;
  snap: Snapshot;
  onPresent?: () => void;
  onShare?: () => void;
  /** ⇧⌘E's bulk sheet. App owns the flag so Escape can be handled centrally. */
  exportOpen?: boolean;
  onCloseExport?: () => void;
}) {
  const tabs: { id: RightTab; label: string }[] = [
    { id: "design", label: "Design" },
    { id: "prototype", label: "Prototype" },
  ];
  const root = snap.pages[snap.page].root;
  const id = snap.selection[0];
  const wp = id ? worldPos(root, id) : null;
  const n = wp?.node;
  const inspect = snap.rightTab === "inspect";
  return (
    <aside className="panel right">
      <div className="right-head">
        <div className="avatar" title="You">
          X
        </div>
        <span className="grow" />
        <Tooltip label={inspect ? "Exit Dev Mode" : "Dev Mode"} shortcut="⇧D">
          <button
            className={`icon-btn dev-toggle${inspect ? " on" : ""}`}
            aria-label="Dev Mode"
            aria-pressed={inspect}
            onClick={() => engine.dispatch({ type: "setRightTab", tab: inspect ? "design" : "inspect" })}
          >
            <Icon name="dev" />
          </button>
        </Tooltip>
        <Tooltip label="Present" shortcut="Esc to exit">
          <button className="icon-btn" aria-label="Present" onClick={() => onPresent?.()}>
            <Icon name="play" />
          </button>
        </Tooltip>
        <Tooltip label="Copy a link to this page">
          <button className="share" onClick={() => onShare?.()}>
            Share
          </button>
        </Tooltip>
      </div>
      <div className="tabs">
        {inspect ? (
          <>
            <button className="tab" aria-current="true">
              Inspect
            </button>
            <button
              className="tab"
              onClick={() => engine.dispatch({ type: "setRightTab", tab: "design" })}
              style={{ color: "var(--dim)", cursor: "pointer" }}
            >
              Design
            </button>
          </>
        ) : (
          tabs.map((t) => (
            <button
              key={t.id}
              className="tab"
              aria-current={snap.rightTab === t.id}
              onClick={() => engine.dispatch({ type: "setRightTab", tab: t.id })}
            >
              {t.label}
            </button>
          ))
        )}
        <ZoomMenu engine={engine} snap={snap} />
      </div>
      <div className="inspector">
        {snap.rightTab === "prototype" && !inspect && (
          <Prototype n={n} engine={engine} snap={snap} onPresent={onPresent} />
        )}
        {inspect && <Inspect n={n} engine={engine} snap={snap} />}
        {snap.rightTab === "design" && !inspect && !n && (
          <PageDesign engine={engine} tool={snap.tool} />
        )}
        {snap.rightTab === "design" && !inspect && n && wp && (
          <Design key={n.id} n={n} x={n.x} y={n.y} engine={engine} snap={snap} />
        )}
      </div>
      {exportOpen && (
        <ExportAssetsDialog engine={engine} snap={snap} onClose={() => onCloseExport?.()} />
      )}
    </aside>
  );
}

/**
 * Figma's File ▸ Export… and Sketch's ⌘⇧E "Export Assets": one sheet listing
 * everything on the page that can be exported, each row with its own format and
 * scale, checkboxes to pick which ones to write. Thumbnails focus the layer so
 * a long list stays navigable.
 */
function ExportAssetsDialog({
  engine,
  snap,
  onClose,
}: {
  engine: Engine;
  snap: Snapshot;
  onClose: () => void;
  onPresent?: () => void;
}) {
  const root = snap.pages[snap.page].root;
  const candidates = useMemo(() => {
    const out: XNode[] = [];
    const walk = (n: XNode) => {
      for (const ch of n.children) {
        if (ch.visible === false) continue;
        // Frames and slices are the export units; anything else only shows up
        // when the layer already carries its own export settings.
        if (ch.kind === "frame" || (ch.exports?.length ?? 0) > 0) out.push(ch);
        else walk(ch);
      }
    };
    walk(root);
    return out;
  }, [root]);
  const selected = new Set(snap.selection);
  const withConfig = (n: XNode) => (n.exports?.length ?? 0) > 0;
  const presetFor = (n: XNode): ExportPreset =>
    n.exports?.[0] ?? { format: "PNG", scale: 1, suffix: "" };
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const n of candidates) if (withConfig(n) || selected.has(n.id)) init[n.id] = true;
    // Opened with nothing configured and nothing selected, the useful default is
    // the top level of the page — that is what "export the design" means.
    if (!Object.keys(init).length) {
      const top = new Set(root.children.map((c) => c.id));
      for (const n of candidates) if (top.has(n.id)) init[n.id] = true;
    }
    return init;
  });
  const [configs, setConfigs] = useState<Record<string, ExportPreset>>(() => {
    const init: Record<string, ExportPreset> = {};
    for (const n of candidates) init[n.id] = presetFor(n);
    return init;
  });
  const [filter, setFilter] = useState("");
  const rows = candidates.filter((n) => n.name.toLowerCase().includes(filter.trim().toLowerCase()));
  // Rasterising every frame is expensive enough that it must not re-run while
  // the sheet is being filtered or ticked; it follows the document instead.
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const n of candidates) out[n.id] = previewUrl(n, { format: "PNG", scale: 0.2, suffix: "" });
    return out;
  }, [candidates]);
  const chosen = candidates.filter((n) => checked[n.id]);
  const total = chosen.reduce((acc, n) => acc + Math.max(1, (n.exports?.length ?? 0) || 1), 0);

  const run = () => {
    if (!chosen.length) {
      toast("Nothing checked to export");
      return;
    }
    // Browsers throttle simultaneous downloads, so each file gets its own turn.
    chosen.forEach((n, i) => {
      const p = configs[n.id] ?? presetFor(n);
      window.setTimeout(() => runExport(n, p), i * 220);
    });
    toast(`Exporting ${plural(chosen.length, "asset")} from "${snap.pages[snap.page].name}"`);
    onClose();
  };

  return createPortal(
    <div className="xmodal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="xmodal" role="dialog" aria-label="Export assets">
        <div className="xmodal-head">
          <h3>Export assets</h3>
          <input
            className="xmodal-filter"
            placeholder="Filter layers"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="link" onClick={() => setChecked(Object.fromEntries(candidates.map((n) => [n.id, true])))}>
            Check all
          </button>
          <button className="link" onClick={() => setChecked({})}>
            Clear
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <Icon name="x-mark" size={14} />
          </button>
        </div>
        <div className="xmodal-body">
          {!rows.length && <p className="empty">Nothing on this page can be exported.</p>}
          {rows.map((n) => {
            const p = configs[n.id] ?? presetFor(n);
            const set = (patch: Partial<ExportPreset>) =>
              setConfigs((v) => ({ ...v, [n.id]: { ...p, ...patch } }));
            return (
              <label className={`xrow${checked[n.id] ? " on" : ""}`} key={n.id}>
                <input
                  type="checkbox"
                  checked={!!checked[n.id]}
                  onChange={(e) => setChecked((v) => ({ ...v, [n.id]: e.target.checked }))}
                />
                <img
                  className="xrow-thumb"
                  src={thumbs[n.id]}
                  alt=""
                  onClick={(e) => {
                    // The thumbnail is Figma's shortcut to the layer itself.
                    e.preventDefault();
                    engine.dispatch({ type: "select", ids: [n.id] });
                    zoomTo(engine, "selection");
                    onClose();
                  }}
                />
                <span className="xrow-name">{n.name}</span>
                <span className="xrow-size">
                  {Math.round(n.w)} × {Math.round(n.h)}
                </span>
                <select value={p.format} onChange={(e) => set({ format: e.target.value as ExportFormat })}>
                  {FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <select value={String(p.scale)} onChange={(e) => set({ scale: Number(e.target.value) })}>
                  {SCALES.map((x) => (
                    <option key={x} value={String(x)}>
                      {x}×
                    </option>
                  ))}
                </select>
                <input
                  className="xrow-suffix"
                  placeholder="@2x"
                  value={p.suffix}
                  onChange={(e) => set({ suffix: e.target.value })}
                  aria-label="File name suffix"
                />
              </label>
            );
          })}
        </div>
        <div className="xmodal-foot">
          <span className="muted">
            {chosen.length ? `${chosen.length} of ${candidates.length} layers · ${total} file${total === 1 ? "" : "s"}` : "No layers selected for export"}
          </span>
          <button className="export-run" disabled={!chosen.length} onClick={run}>
            Export {chosen.length || ""}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}


interface PresetCategory {
  category: string;
  icon: string;
  items: { name: string; w: number; h: number }[];
}

const PRESET_GROUPS: PresetCategory[] = [
  {
    category: "Phone",
    icon: "phone",
    items: [
      { name: "iPhone 16 Pro", w: 393, h: 852 },
      { name: "iPhone 16 Pro Max", w: 440, h: 956 },
      { name: "iPhone 15 / 14", w: 393, h: 852 },
      { name: "Google Pixel 8", w: 412, h: 915 },
    ],
  },
  {
    category: "Tablet",
    icon: "tablet",
    items: [
      { name: "iPad Pro 11\"", w: 834, h: 1194 },
      { name: "iPad Pro 12.9\"", w: 1024, h: 1366 },
    ],
  },
  {
    category: "Desktop",
    icon: "desktop",
    items: [
      { name: "Desktop", w: 1440, h: 1024 },
      { name: "MacBook Air", w: 1280, h: 832 },
      { name: "MacBook Pro 14\"", w: 1512, h: 982 },
      { name: "Wireframe", w: 1200, h: 800 },
    ],
  },
  {
    category: "Presentation",
    icon: "slide",
    items: [
      { name: "Slide 16:9", w: 1920, h: 1080 },
      { name: "Slide 4:3", w: 1024, h: 768 },
    ],
  },
  {
    category: "Social",
    icon: "community",
    items: [
      { name: "Instagram Post", w: 1080, h: 1080 },
      { name: "Instagram Story", w: 1080, h: 1920 },
      { name: "X / Twitter Post", w: 1200, h: 675 },
    ],
  },
];

function PageDesign({ engine, tool }: { engine: Engine; tool: string }) {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  return (
    <>
      {tool !== "frame" && (
        // Figma uses the empty right panel to teach rather than leaving it
        // blank; with nothing selected the only controls are page-level, so
        // say what the panel will show once something is picked.
        <div className="empty-state">
          <Icon name="move" size={20} />
          <p className="empty-title">Nothing selected</p>
          <p className="empty-body">
            Pick a layer — on the canvas or in the Layers list — and this panel becomes its
            position, size, fill, stroke and effects.
          </p>
          <p className="empty-hint">
            Right now these controls are the page&rsquo;s: background and pixel grid. <kbd>&#8984;</kbd>
            <kbd>K</kbd> finds every command.
          </p>
        </div>
      )}
      {tool === "frame" && (
        <>
          <div className="h-row">
            <h3>Frame Presets</h3>
          </div>
          <div className="presets" style={{ maxHeight: 340, overflowY: "auto" }}>
            {PRESET_GROUPS.map((grp) => (
              <div key={grp.category} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", padding: "4px 8px" }}>
                  <Icon name={grp.icon} size={14} />
                  <span>{grp.category}</span>
                </div>
                {grp.items.map((p) => (
                  <button
                    key={p.name}
                    onClick={() =>
                      engine.dispatch({
                        type: "add",
                        kind: "frame",
                        x: 80,
                        y: 80,
                        w: p.w,
                        h: p.h,
                        extra: { name: p.name, overflow: "clip", fill: "#ffffff", fillVisible: true },
                      })
                    }
                  >
                    {p.name}
                    <span className="sz">
                      {p.w} × {p.h}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="hr" />
        </>
      )}
      <div className="h-row">
        <h3>Background</h3>
      </div>
      <div className="insp-pad">
        <ColorRow
          value={root.fill}
          opacity={Math.round((root.fillOpacity ?? 1) * 100)}
          visible={root.fillVisible !== false && !isNone(root.fill)}
          recents={collectColors(root)}
          onChange={(fill) => engine.dispatch({ type: "patch", id: root.id, patch: { fill, fillVisible: true } })}
          onOpacity={(v) =>
            engine.dispatch({ type: "patch", id: root.id, patch: { fillOpacity: v / 100 } })
          }
          onVisible={(v) => engine.dispatch({ type: "patch", id: root.id, patch: { fillVisible: v } })}
        />
      </div>
      <div className="hr" />
      <div className="h-row">
        <h3>Pixel grid</h3>
      </div>
      <div className="insp-pad">
        <ColorRow
          value={snap.pages[snap.page].pixelGridColor || "#cccccc"}
          opacity={snap.pages[snap.page].pixelGrid ? 100 : 0}
          visible={!!snap.pages[snap.page].pixelGrid}
          recents={["#cccccc", "#e6e6e6", "#8a8a8a", "#6366f1"]}
          onChange={(pixelGridColor) =>
            engine.dispatch({ type: "patchPage", patch: { pixelGridColor, pixelGrid: true } })
          }
          onOpacity={(v) => engine.dispatch({ type: "patchPage", patch: { pixelGrid: v > 0 } })}
          onVisible={(pixelGrid) => engine.dispatch({ type: "patchPage", patch: { pixelGrid } })}
        />
      </div>
      <div className="hr" />
      <ExportBlock n={root} engine={engine} />
    </>
  );
}

function Prototype({
  n,
  engine,
  snap,
  onPresent,
}: {
  n?: XNode;
  engine: Engine;
  snap: Snapshot;
  onPresent?: () => void;
}) {
  const frames = framesOf(snap.pages[snap.page].root);
  const start = snap.pages[snap.page].flowStart;
  const startName = frames.find((f) => f.id === start)?.name || frames[0]?.name || "—";
  const interactions = n?.interactions ?? [];
  const setIx = (next: Interaction[]) => {
    if (!n) return;
    engine.dispatch({ type: "setInteractions", id: n.id, interactions: next });
  };
  return (
    <>
      <div className="h-row">
        <h3>Flow starting point</h3>
      </div>
      <div className="proto-row">
        <span>Start</span>
        <select
          value={start || frames[0]?.id || ""}
          onChange={(e) => engine.dispatch({ type: "patchPage", patch: { flowStart: e.target.value } })}
          style={{ border: 0, background: "var(--input)", borderRadius: 6, height: 24, padding: "0 6px" }}
        >
          {frames.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      <div className="h-row" style={{ marginTop: 8 }} onClick={() => {}}>
        <h3>Prototype settings</h3>
      </div>
      <div className="proto-row">
        <span>Device</span>
        <select
          value={snap.prototypeDevice || "none"}
          onChange={(e) =>
            engine.dispatch({ type: "setPrototypeDevice", device: e.target.value as ProtoDevice })
          }
          style={{ border: 0, background: "var(--input)", borderRadius: 6, height: 24, padding: "0 6px" }}
        >
          <option value="none">None (borderless)</option>
          {DEVICE_GROUPS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="proto-row">
        <span>Size</span>
        <select
          value={snap.prototypeScale || "fit"}
          onChange={(e) =>
            engine.dispatch({ type: "setPrototypeScale", scale: e.target.value as "fit" | "100%" | "fill" })
          }
          style={{ border: 0, background: "var(--input)", borderRadius: 6, height: 24, padding: "0 6px" }}
        >
          <option value="fit">Zoom to fit</option>
          <option value="100%">Zoom to 100%</option>
          <option value="fill">Fill screen</option>
        </select>
      </div>
      {deviceFor(snap.prototypeDevice) && (
        <div className="proto-row">
          <span>Orientation</span>
          <div className="seg icons">
            {(["portrait", "landscape"] as const).map((o) => (
              <button
                key={o}
                className={(snap.prototypeOrientation ?? "portrait") === o ? "on" : ""}
                title={o === "portrait" ? "Portrait" : "Landscape"}
                onClick={() => engine.dispatch({ type: "setPrototypeOrientation", orientation: o })}
              >
                <Icon name={o === "portrait" ? "phone" : "desktop"} size={14} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The mockup preview shows the selected frame inside the real device
          shell, so the choice is visible before pressing Play. */}
      <div className="proto-preview device" style={{ marginTop: 8 }}>
        <DevicePreview
          spec={deviceFor(snap.prototypeDevice)}
          fill={n?.fillVisible !== false && n?.fill && n.fill.length >= 7 ? n.fill : "#fff"}
          radius={n?.cornerRadii?.[0] || 0}
        />
      </div>
      <p className="muted">Flow starts at {startName}. Esc steps back, then exits.</p>

      <div className="h-row" style={{ marginTop: 8 }}>
        <h3>Interactions</h3>
        <button
          className="plus"
          title="Add interaction"
          disabled={!n}
          onClick={() =>
            n &&
            setIx([
              ...interactions,
              {
                trigger: "onClick",
                action: "navigate",
                destination: frames.find((f) => f.id !== n.id)?.id || "",
                animation: "instant",
                delay: 0,
              },
            ])
          }
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {!n && <p className="muted">Select a layer to add On click → Navigate.</p>}
      {n &&
        interactions.map((ix, i) => (
          <div key={i} className="insp-pad" style={{ display: "grid", gap: 5, marginBottom: 8, background: "var(--hover)", borderRadius: 8, padding: 8 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <select
                style={{ flex: 1 }}
                value={ix.trigger}
                onChange={(e) => {
                  const next = interactions.map((x, j) =>
                    j === i ? { ...x, trigger: e.target.value as ProtoTrigger } : x,
                  );
                  setIx(next);
                }}
              >
                <option value="onClick">On click</option>
                <option value="onHover">While hovering</option>
                <option value="afterDelay">After delay</option>
                <option value="mouseEnter">Mouse enter</option>
                <option value="mouseLeave">Mouse leave</option>
                <option value="keyPress">Key / Gamepad press</option>
                <option value="onDrag">On drag</option>
              </select>
              <button
                className="mini minus"
                title="Remove interaction"
                onClick={() => setIx(interactions.filter((_, j) => j !== i))}
              >
                <Icon name="minus" size={12} />
              </button>
            </div>

            <select
              value={ix.action}
              onChange={(e) => {
                const action = e.target.value as Interaction["action"];
                setIx(interactions.map((x, j) => (j === i ? { ...x, action } : x)));
              }}
            >
              <option value="navigate">Navigate to</option>
              <option value="openOverlay">Open overlay</option>
              <option value="closeOverlay">Close overlay</option>
              <option value="swapOverlay">Swap overlay</option>
              <option value="back">Back</option>
              <option value="scrollTo">Scroll to</option>
              <option value="openUrl">Open link</option>
              <option value="setVariable">Set variable</option>
            </select>

            {(ix.action === "navigate" ||
              ix.action === "scrollTo" ||
              ix.action === "openOverlay" ||
              ix.action === "swapOverlay") && (
              <select
                value={ix.destination}
                onChange={(e) =>
                  setIx(interactions.map((x, j) => (j === i ? { ...x, destination: e.target.value } : x)))
                }
              >
                <option value="">Choose target…</option>
                {frames
                  .filter((f) => f.id !== n.id)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            )}

            {(ix.action === "openOverlay" || ix.action === "swapOverlay") && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                <select
                  value={ix.overlayPosition || "center"}
                  onChange={(e) =>
                    setIx(
                      interactions.map((x, j) =>
                        j === i ? { ...x, overlayPosition: e.target.value as "center" | "top" | "bottom" | "manual" } : x,
                      ),
                    )
                  }
                >
                  <option value="center">Center modal</option>
                  <option value="bottom">Bottom sheet</option>
                  <option value="top">Top banner</option>
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--dim)" }}>
                  <input
                    type="checkbox"
                    checked={ix.overlayCloseOutside !== false}
                    onChange={(e) =>
                      setIx(
                        interactions.map((x, j) =>
                          j === i ? { ...x, overlayCloseOutside: e.target.checked } : x,
                        ),
                      )
                    }
                  />
                  Close outside
                </label>
              </div>
            )}

            {ix.action === "openUrl" && (
              <input
                placeholder="https://example.com"
                value={ix.destination}
                onChange={(e) =>
                  setIx(interactions.map((x, j) => (j === i ? { ...x, destination: e.target.value } : x)))
                }
              />
            )}

            {ix.action === "setVariable" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                <select
                  value={ix.variableId || ""}
                  onChange={(e) =>
                    setIx(interactions.map((x, j) => (j === i ? { ...x, variableId: e.target.value } : x)))
                  }
                >
                  <option value="">Choose variable…</option>
                  {(snap.variables || []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <select
                  value={ix.variableOp || "toggle"}
                  onChange={(e) =>
                    setIx(
                      interactions.map((x, j) =>
                        j === i ? { ...x, variableOp: e.target.value as "set" | "increment" | "decrement" | "toggle" } : x,
                      ),
                    )
                  }
                >
                  <option value="toggle">Toggle boolean</option>
                  <option value="increment">Increment +1</option>
                  <option value="decrement">Decrement -1</option>
                </select>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 60px", gap: 4 }}>
              <select
                value={ix.animation}
                onChange={(e) =>
                  setIx(
                    interactions.map((x, j) =>
                      j === i ? { ...x, animation: e.target.value as ProtoAnim } : x,
                    ),
                  )
                }
              >
                <option value="instant">Instant</option>
                <option value="dissolve">Dissolve</option>
                <option value="smart">Smart animate</option>
                <option value="slideInLeft">Slide in (Left)</option>
                <option value="slideInRight">Slide in (Right)</option>
                <option value="slideInTop">Slide in (Top)</option>
                <option value="slideInBottom">Slide in (Bottom)</option>
                <option value="pushLeft">Push (Left)</option>
                <option value="pushRight">Push (Right)</option>
              </select>
              <input
                type="number"
                placeholder="250ms"
                title="Duration in ms"
                value={ix.duration || 250}
                onChange={(e) => {
                  const d = parseInt(e.target.value, 10) || 250;
                  setIx(interactions.map((x, j) => (j === i ? { ...x, duration: d } : x)));
                }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <select
                value={ix.easing || "easeOut"}
                onChange={(e) =>
                  setIx(
                    interactions.map((x, j) =>
                      j === i ? { ...x, easing: e.target.value as ProtoEasing } : x,
                    ),
                  )
                }
                title="Animation Easing Curve"
              >
                <option value="easeOut">Ease out</option>
                <option value="easeIn">Ease in</option>
                <option value="easeInOut">Ease in and out</option>
                <option value="linear">Linear</option>
                <option value="spring">Spring (Gentle)</option>
                <option value="bouncy">Spring (Bouncy)</option>
              </select>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 10,
                  color: "var(--fg-muted)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
                title="Match layers by name and interpolate their properties"
              >
                <input
                  type="checkbox"
                  checked={Boolean(ix.smartMatch || ix.animation === "smart")}
                  disabled={ix.animation === "smart"}
                  onChange={(e) =>
                    setIx(
                      interactions.map((x, j) =>
                        j === i ? { ...x, smartMatch: e.target.checked } : x,
                      ),
                    )
                  }
                />
                Smart match
              </label>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px", background: "var(--bg-subtle)", borderRadius: 4 }}>
              <svg width="32" height="18" viewBox="0 0 32 18" style={{ overflow: "visible" }}>
                {ix.easing === "linear" && <line x1="2" y1="16" x2="30" y2="2" stroke="var(--accent)" strokeWidth="1.5" />}
                {ix.easing === "easeIn" && <path d="M 2 16 Q 22 16, 30 2" fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
                {(ix.easing === "easeOut" || !ix.easing) && <path d="M 2 16 Q 8 2, 30 2" fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
                {ix.easing === "easeInOut" && <path d="M 2 16 C 14 16, 18 2, 30 2" fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
                {ix.easing === "spring" && <path d="M 2 16 C 10 0, 16 2, 22 4 C 26 3, 30 2, 30 2" fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
                {ix.easing === "bouncy" && <path d="M 2 16 C 8 -4, 14 6, 20 0 C 24 4, 30 2, 30 2" fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
              </svg>
              <span style={{ fontSize: 10, color: "var(--dim)" }}>
                {ix.duration || 250}ms • {ix.easing || "easeOut"}
              </span>
            </div>
          </div>
        ))}
      <div className="insp-pad">
        <button className="export-run" onClick={() => onPresent?.()}>
          Present Prototype
        </button>
      </div>
    </>
  );
}

/**
 * CSS for the layer. `unit` is Figma's Dev Mode setting — the numbers are
 * the same, only the unit they are written in changes.
 */
function generateCss(n: XNode, unit: DevUnit = "px"): string {
  const rules: string[] = [
    `/* ${n.name} (${n.kind}) */`,
    `width: ${devLen(n.w, unit)};`,
    `height: ${devLen(n.h, unit)};`,
  ];
  if (n.cornerRadii && n.cornerRadii.some((r) => r > 0)) {
    if (n.cornerIndependent) {
      rules.push(`border-radius: ${[n.cornerRadii[0], n.cornerRadii[1], n.cornerRadii[3], n.cornerRadii[2]].map((r) => devLen(r, unit)).join(" ")};`);
    } else {
      rules.push(`border-radius: ${devLen(n.cornerRadii[0], unit)};`);
    }
    // Corner smoothing has no CSS equivalent, so the snippet says what it is
    // rather than pretending the radius alone reproduces the curve.
    if (n.cornerSmoothing)
      rules.push(`/* corner smoothing ${Math.round(n.cornerSmoothing * 100)}% - border-radius is a circular arc */`);
  }
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
    rules.push(`background: ${n.fill};`);
  }
  if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint) {
    const sides = sideWidths(n.strokeSides, n.strokeSideW, n.strokeWidth);
    if (sides.some((w) => w !== sides[0])) {
      // Figma exports individual strokes as per-side borders; a side with no
      // weight still needs a style, or the corner mitre disappears.
      rules.push(`border-width: ${sides.map((w) => devLen(w, unit)).join(" ")};`);
      rules.push(`border-style: ${sides.map((w) => (w > 0 ? "solid" : "none")).join(" ")};`);
      rules.push(`border-color: ${n.strokePaint};`);
    } else {
      rules.push(`border: ${devLen(n.strokeWidth, unit)} solid ${n.strokePaint};`);
    }
    if (n.strokeDashPattern?.length)
      rules.push(`/* dashes: ${n.strokeDashPattern.join(", ")} - no CSS equivalent */`);
  }
  if (n.opacity < 1) {
    rules.push(`opacity: ${Math.round(n.opacity * 100) / 100};`);
  }
  if (n.layout) {
    rules.push("display: flex;");
    rules.push(`flex-direction: ${n.layout.direction === "horizontal" ? "row" : "column"};`);
    if (n.layout.gap) rules.push(`gap: ${devLen(n.layout.gap, unit)};`);
    const [pl, pr, pt, pb] = n.layout.padding;
    if (pl || pr || pt || pb) {
      rules.push(`padding: ${[pt, pr, pb, pl].map((v) => devLen(v, unit)).join(" ")};`);
    }
    if (n.layout.align === "center") rules.push("align-items: center;");
    else if (n.layout.align === "max") rules.push("align-items: flex-end;");
    else if (n.layout.align === "baseline") rules.push("align-items: baseline;");
    if (n.layout.justify === "center") rules.push("justify-content: center;");
    else if (n.layout.justify === "between") rules.push("justify-content: space-between;");
    else if (n.layout.justify === "max") rules.push("justify-content: flex-end;");
    if (n.layout.wrap) rules.push("flex-wrap: wrap;");
  }
  if (n.kind === "text") {
    rules.push(`font-family: "${n.fontFamily}", sans-serif;`);
    rules.push(`font-size: ${devLen(n.fontSize, unit)};`);
    rules.push(`font-weight: ${n.fontWeight};`);
    if (n.lineHeight) rules.push(`line-height: ${devLen(Math.round(n.lineHeight), unit)};`);
    if (n.letterSpacing) rules.push(`letter-spacing: ${devLen(n.letterSpacing, unit)};`);
    if (n.textAlign && n.textAlign !== "left") rules.push(`text-align: ${n.textAlign};`);
    // The three type settings that have a real CSS equivalent are handed over
    // by name, so the snippet reproduces the paragraph instead of only noting
    // that it differs.
    if ((n.textWrap === "balance" || n.textWrap === "pretty")) rules.push(`text-wrap: ${n.textWrap};`);
    if (n.listStyle && n.listStyle !== "none")
      rules.push(`list-style-type: ${n.listStyle === "numbered" ? "decimal" : "disc"};`);
    if (n.paragraphIndent) rules.push(`text-indent: ${devLen(n.paragraphIndent, unit)};`);
  }
  if (n.effects?.length) {
    const shadows = n.effects
      .filter((e) => e.visible && (e.kind === "drop-shadow" || e.kind === "inner-shadow"))
      .map((e) => `${e.kind === "inner-shadow" ? "inset " : ""}${[e.x, e.y, e.blur, e.spread].map((v) => devLen(v, unit)).join(" ")} ${e.color}`);
    if (shadows.length) rules.push(`box-shadow: ${shadows.join(", ")};`);
  }
  return rules.join("\n");
}

function generateTailwind(n: XNode): string {
  const cls: string[] = [];
  if (n.sizingW === "fill") cls.push("w-full");
  else cls.push(`w-[${Math.round(n.w)}px]`);

  if (n.sizingH === "fill") cls.push("h-full");
  else cls.push(`h-[${Math.round(n.h)}px]`);

  if (n.cornerRadii && n.cornerRadii.some((r) => r > 0)) {
    if (n.cornerIndependent) {
      if (n.cornerRadii[0]) cls.push(`rounded-tl-[${n.cornerRadii[0]}px]`);
      if (n.cornerRadii[1]) cls.push(`rounded-tr-[${n.cornerRadii[1]}px]`);
      if (n.cornerRadii[3]) cls.push(`rounded-br-[${n.cornerRadii[3]}px]`);
      if (n.cornerRadii[2]) cls.push(`rounded-bl-[${n.cornerRadii[2]}px]`);
    } else {
      cls.push(`rounded-[${n.cornerRadii[0]}px]`);
    }
  }
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
    cls.push(`bg-[${n.fill}]`);
  }
  if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint) {
    cls.push(`border-[${n.strokeWidth}px]`, `border-[${n.strokePaint}]`);
  }
  if (n.opacity < 1) {
    cls.push(`opacity-${Math.round(n.opacity * 100)}`);
  }
  if (n.layout) {
    cls.push("flex");
    cls.push(n.layout.direction === "horizontal" ? "flex-row" : "flex-col");
    if (n.layout.gap) cls.push(`gap-[${n.layout.gap}px]`);
    const [pl, pr, pt, pb] = n.layout.padding;
    if (pl === pr && pt === pb && pl === pt && pl > 0) cls.push(`p-[${pl}px]`);
    else {
      if (pl || pr) cls.push(`px-[${pl}px]`);
      if (pt || pb) cls.push(`py-[${pt}px]`);
    }
    if (n.layout.align === "center") cls.push("items-center");
    else if (n.layout.align === "max") cls.push("items-end");
    else if (n.layout.align === "baseline") cls.push("items-baseline");
    if (n.layout.justify === "center") cls.push("justify-center");
    else if (n.layout.justify === "between") cls.push("justify-between");
    else if (n.layout.justify === "max") cls.push("justify-end");
    if (n.layout.wrap) cls.push("flex-wrap");
  }
  if (n.kind === "text") {
    cls.push(`text-[${n.fontSize}px]`);
    if (n.fontWeight >= 700) cls.push("font-bold");
    else if (n.fontWeight >= 600) cls.push("font-semibold");
    else if (n.fontWeight >= 500) cls.push("font-medium");
    if (n.lineHeight) cls.push(`leading-[${Math.round(n.lineHeight)}px]`);
    if (n.textAlign && n.textAlign !== "left") cls.push(`text-${n.textAlign}`);
  }
  return `<!-- ${n.name} -->\n<div className="${cls.join(" ")}">\n  {/* Children */}\n</div>`;
}

function generateSwiftUI(n: XNode): string {
  const hex = (c: string) => c.replace("#", "").slice(0, 6).toUpperCase();
  if (n.kind === "text") {
    const weight = n.fontWeight >= 700 ? ".bold" : n.fontWeight >= 600 ? ".semibold" : n.fontWeight >= 500 ? ".medium" : ".regular";
    return `Text("${n.text || n.name}")
    .font(.system(size: ${n.fontSize}, weight: ${weight}))
    .foregroundColor(Color(hex: "${hex(n.fill || "#000000")}"))`;
  }
  const stack = n.layout ? (n.layout.direction === "horizontal" ? "HStack" : "VStack") : "ZStack";
  const spacing = n.layout?.gap ? `spacing: ${n.layout.gap}` : "";
  const align = n.layout?.align === "center" ? "alignment: .center" : n.layout?.align === "max" ? "alignment: .trailing" : "";
  const args = [align, spacing].filter(Boolean).join(", ");
  const [pl, pr, pt, pb] = n.layout?.padding ?? [0, 0, 0, 0];
  const padStr = pl || pr || pt || pb ? `\n    .padding(EdgeInsets(top: ${pt}, leading: ${pl}, bottom: ${pb}, trailing: ${pr}))` : "";
  const bgStr = n.fillVisible !== false && n.fill && n.fill !== "#00000000" ? `\n    .background(Color(hex: "${hex(n.fill)}"))` : "";
  const cornerStr = n.cornerRadii[0] > 0 ? `\n    .cornerRadius(${n.cornerRadii[0]})` : "";
  const borderStr = n.strokeVisible && n.strokeWidth > 0 ? `\n    .overlay(RoundedRectangle(cornerRadius: ${n.cornerRadii[0] || 0}).stroke(Color(hex: "${hex(n.strokePaint)}"), lineWidth: ${n.strokeWidth}))` : "";

  return `${stack}(${args}) {
    // Child views
}
.frame(width: ${Math.round(n.w)}, height: ${Math.round(n.h)})${padStr}${bgStr}${cornerStr}${borderStr}`;
}

function generateCompose(n: XNode): string {
  const hex8 = (c: string) => "0xFF" + c.replace("#", "").slice(0, 6).toUpperCase();
  if (n.kind === "text") {
    const weight = n.fontWeight >= 700 ? "Bold" : n.fontWeight >= 600 ? "SemiBold" : n.fontWeight >= 500 ? "Medium" : "Normal";
    return `Text(
    text = "${n.text || n.name}",
    fontSize = ${n.fontSize}.sp,
    fontWeight = FontWeight.${weight},
    color = Color(${hex8(n.fill || "#000000")})
)`;
  }
  const container = n.layout ? (n.layout.direction === "horizontal" ? "Row" : "Column") : "Box";
  const mod: string[] = [`Modifier.size(${Math.round(n.w)}.dp, ${Math.round(n.h)}.dp)`];
  if (n.cornerRadii[0] > 0) mod.push(`clip(RoundedCornerShape(${n.cornerRadii[0]}.dp))`);
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") mod.push(`background(Color(${hex8(n.fill)}))`);
  if (n.strokeVisible && n.strokeWidth > 0) mod.push(`border(${n.strokeWidth}.dp, Color(${hex8(n.strokePaint)}))`);
  const [pl, pr, pt, pb] = n.layout?.padding ?? [0, 0, 0, 0];
  if (pl || pr || pt || pb) mod.push(`padding(${pt}.dp, ${pr}.dp, ${pb}.dp, ${pl}.dp)`);

  return `${container}(
    modifier = ${mod.join("\n        .")}
) {
    // Child composables
}`;
}

function generateFlutter(n: XNode): string {
  const hex = (n.fill || "#000000").replace("#", "").padEnd(6, "0");
  return `Container(
  width: ${Math.round(n.w)}.0,
  height: ${Math.round(n.h)}.0,
  decoration: BoxDecoration(
    color: const Color(0xFF${hex.toUpperCase()}),
    borderRadius: BorderRadius.circular(${n.cornerRadii[0]}.0),
  ),
  child: ${n.kind === "text" ? `Text(
    '${n.text.replace(/'/g, "\\'")}',
    style: TextStyle(
      fontSize: ${n.fontSize}.0,
      fontWeight: FontWeight.w${n.fontWeight},
    ),
  )` : "// Children"},
)`;
}

function generateSvg(n: XNode): string {
  let pathD = "";
  if (n.vectorNetwork && n.vectorNetwork.segments.length > 0) {
    pathD = vectorNetworkToSvgPath(n.vectorNetwork);
  } else if (n.path.length > 0) {
    pathD = n.path
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ") + (n.closed ? " Z" : "");
  }
  const w = Math.round(Math.max(1, n.w));
  const h = Math.round(Math.max(1, n.h));

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path
    d="${pathD || `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`}"
    fill="${n.fillVisible && !isNone(n.fill) ? n.fill : "none"}"
    stroke="${n.strokeVisible && !isNone(n.strokePaint) ? n.strokePaint : "none"}"
    stroke-width="${n.strokeWidth}"
  />
</svg>`;
}

function generateFigmaJson(n: XNode): string {
  const hexToFigmaColor = (hex: string) => {
    const clean = hex.replace("#", "");
    const r = parseInt(clean.slice(0, 2) || "0", 16) / 255;
    const g = parseInt(clean.slice(2, 4) || "0", 16) / 255;
    const b = parseInt(clean.slice(4, 6) || "0", 16) / 255;
    return { r, g, b, a: 1 };
  };

  const payload: Record<string, unknown> = {
    id: n.id,
    name: n.name,
    type: n.kind.toUpperCase(),
    visible: n.visible,
    opacity: n.opacity,
    blendMode: n.blendMode.toUpperCase(),
    absoluteBoundingBox: {
      x: n.x,
      y: n.y,
      width: n.w,
      height: n.h,
    },
    constraints: {
      horizontal: n.constraintH.toUpperCase(),
      vertical: n.constraintV.toUpperCase(),
    },
    fills: n.fillVisible && !isNone(n.fill)
      ? [{
          type: "SOLID",
          visible: true,
          opacity: n.fillOpacity,
          color: hexToFigmaColor(n.fill),
        }]
      : [],
    strokes: n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)
      ? [{
          type: "SOLID",
          visible: true,
          opacity: n.strokeOpacity,
          color: hexToFigmaColor(n.strokePaint),
        }]
      : [],
    strokeWeight: n.strokeWidth,
    strokeAlign: n.strokeAlign.toUpperCase(),
    strokeCap: n.strokeCap.toUpperCase(),
    strokeJoin: n.strokeJoin.toUpperCase(),
    cornerRadius: n.cornerRadii[0],
    effects: n.effects,
  };

  if (n.layout) {
    payload.layoutMode = n.layout.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    payload.itemSpacing = n.layout.gap;
    payload.paddingLeft = n.layout.padding[0];
    payload.paddingRight = n.layout.padding[1];
    payload.paddingTop = n.layout.padding[2];
    payload.paddingBottom = n.layout.padding[3];
  }

  if (n.kind === "text") {
    payload.characters = n.text;
    payload.style = {
      fontFamily: n.fontFamily,
      fontSize: n.fontSize,
      fontWeight: n.fontWeight,
      textAlignHorizontal: n.textAlign.toUpperCase(),
    };
  }

  if (n.vectorNetwork && n.vectorNetwork.vertices.length > 0) {
    payload.vectorNetwork = {
      vertices: n.vectorNetwork.vertices,
      segments: n.vectorNetwork.segments,
      regions: n.vectorNetwork.regions,
    };
  }

  return JSON.stringify(payload, null, 2);
}

function BoxModelDiagram({ n }: { n: XNode }) {
  const [pl, pr, pt, pb] = n.layout?.padding ?? [0, 0, 0, 0];
  return (
    <div className="box-model-diagram">
      {/* Only auto-layout frames have padding; showing 0 0 0 0 elsewhere reads
          as a fact when it is an absence. */}
      {n.layout && <div className="bm-padding-label">padding: {pt} {pr} {pb} {pl}</div>}
      <div className="bm-outer">
        <div className="bm-pad-box">
          <div className="bm-inner">
            <span className="bm-dims">{Math.round(n.w)} × {Math.round(n.h)}</span>
            {n.cornerRadii[0] > 0 && <span className="bm-radius">r:{n.cornerRadii[0]}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Dev Mode. Figma's inspect panel is the reference for behaviour: a Code|List
 * toggle over the layer properties, a language picker with a units setting,
 * click any value to copy it, then component info, assets, prototype
 * interactions and annotations. The styling is ours.
 */
function Inspect({ n, engine, snap }: { n?: XNode; engine: Engine; snap: Snapshot }) {
  const [mode, setMode] = useState<"code" | "list">("code");
  // Language and units are app-wide Dev Mode preferences (see devPrefs.ts) rather
  // than panel state: that is what lets the right-click menu and the ⌥⇧C chord
  // copy exactly what this panel shows, and it is why the choice outlives a
  // reload, as Figma's Inspect settings do.
  const { format, unit } = useSyncExternalStore(subscribeDevPrefs, getDevPrefs, getDevPrefs);
  const setFormat = (f: DevFormat) => setDevPrefs({ format: f });
  const setUnit = (u: DevUnit) => setDevPrefs({ unit: u });

  if (!n) {
    return (
      <div className="insp-pad dev-empty">
        <p className="dev-empty-title">Select a layer to inspect</p>
        <ul>
          <li>
            <b>⌥ hover</b> a layer with one selected to measure the distance between them.
          </li>
          <li>
            <b>⇧⌘E</b> exports every asset on this page at once.
          </li>
          <li>
            <b>⇧D</b> leaves Dev Mode.
          </li>
        </ul>
        <DevTokens snap={snap} />
      </div>
    );
  }

  const code = renderDevCode(n, format, unit);
  return (
    <>
      <div className="h-row dev-head">
        <h3>Dev Mode</h3>
        <div className="seg dev-seg" role="tablist" aria-label="Inspect view">
          <button
            role="tab"
            aria-selected={mode === "code"}
            className={mode === "code" ? "on" : ""}
            onClick={() => setMode("code")}
          >
            Code
          </button>
          <button
            role="tab"
            aria-selected={mode === "list"}
            className={mode === "list" ? "on" : ""}
            onClick={() => setMode("list")}
          >
            List
          </button>
        </div>
      </div>
      <div className="insp-pad dev-preview">
        {n.kind === "text" ? <TypeSpecimen n={n} /> : <BoxModelDiagram n={n} />}
      </div>
      {mode === "code" ? (
        <div className="insp-pad dev-code">
          <div className="dev-codebar">
            <DevLangMenu
              format={format}
              setFormat={setFormat}
              unit={unit}
              setUnit={setUnit}
              showUnits={format === "css"}
            />
            <Tooltip label="Copy the snippet">
              <button
                className="mini"
                aria-label="Copy code"
                onClick={() => {
                  copyText(code);
                  toast(`Copied ${devLangLabel(format)}`);
                }}
              >
                <Icon name="copy" size={12} />
              </button>
            </Tooltip>
          </div>
          <pre className="css-block dev-pre">{code}</pre>
        </div>
      ) : (
        <DevList n={n} snap={snap} unit={unit} />
      )}
      <DevComponent n={n} engine={engine} snap={snap} />
      <DevAssets n={n} engine={engine} />
      <DevInteractions n={n} engine={engine} snap={snap} />
      <DevAnnotations n={n} engine={engine} snap={snap} />
    </>
  );
}

/** Value of a property in the unit the developer asked for. */
function devLen(v: number, unit: DevUnit): string {
  const r = Math.round(v * 100) / 100;
  if (unit === "rem") return `${Math.round((r / 16) * 10000) / 10000}rem`;
  return `${r}px`;
}

/* --------------------------------------------------------------------- tokens */

/** Turn a token name into a CSS custom-property name. */
function kebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type TokenRow = { group: string; name: string; value: string; color?: string };

/**
 * The file's colour and number tokens, offered as CSS custom properties or as a
 * JSON token file. Figma puts styles and variables in the properties panel when
 * nothing is selected; Sketch's handoff exports the same values as CSS or JSON.
 * A developer who has just inspected one layer usually wants the whole palette,
 * and until now had to read it off the Assets tab one row at a time.
 */
function DevTokens({ snap }: { snap: Snapshot }) {
  const rows: TokenRow[] = [];
  for (const v of snap.variables ?? []) {
    const value = typeof v.value === "string" ? v.value : String(v.value);
    rows.push({
      group: v.collection,
      name: v.name,
      value,
      color: v.type === "color" ? value : undefined,
    });
  }
  for (const s of snap.styles) {
    if (s.kind === "paint") rows.push({ group: "Styles", name: s.name, value: s.color, color: s.color });
  }
  if (!rows.length) return null;

  const byGroup = new Map<string, TokenRow[]>();
  for (const r of rows) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }
  const css = `:root {\n${[...byGroup.entries()]
    .map(([g, list]) => `  /* ${g} */\n${list.map((r) => `  --${kebab(`${g}-${r.name}`)}: ${r.value};`).join("\n")}`)
    .join("\n")}\n}`;
  const json = JSON.stringify(
    Object.fromEntries(
      [...byGroup.entries()].map(([g, list]) => [
        kebab(g) || "tokens",
        Object.fromEntries(list.map((r) => [kebab(r.name), { value: r.value, type: r.color ? "color" : "number" }])),
      ]),
    ),
    null,
    2,
  );

  const copy = (text: string, what: string) => {
    copyText(text);
    toast(`Copied ${what} \u00b7 ${rows.length} tokens`);
  };

  return (
    <div className="dev-tokens">
      <div className="dev-tokens-head">
        <b>Tokens in this file</b>
        <span>{rows.length}</span>
        <button className="mini" title="Copy as CSS custom properties" onClick={() => copy(css, "CSS variables")}>
          CSS
        </button>
        <button className="mini" title="Copy as a JSON token file" onClick={() => copy(json, "JSON")}>
          JSON
        </button>
        <button
          className="mini"
          title="Download tokens.json"
          onClick={() => {
            downloadBlob(new Blob([json], { type: "application/json" }), "tokens.json");
            toast("Downloaded tokens.json");
          }}
        >
          <Icon name="export" size={12} />
        </button>
      </div>
      <p className="dev-tokens-note">
        Colours are hex as stored; numbers carry no unit, so spacing and radius land as raw
        values for your preprocessor to interpret.
      </p>
      {[...byGroup.entries()].map(([g, list]) => (
        <div className="dev-tokens-group" key={g}>
          <p className="menu-label">{g}</p>
          {list.map((r) => (
            <button
              className="dev-token"
              key={`${g}/${r.name}`}
              title="Click to copy this value"
              onClick={() => {
                copyText(r.value);
                toast(`Copied ${r.name} \u00b7 ${r.value}`);
              }}
            >
              {r.color ? <span className="dev-token-sw" style={{ background: r.color }} aria-hidden /> : null}
              <span className="dev-token-name">{r.name}</span>
              <span className="dev-token-val">{r.value}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function generateDesignTokens(n: XNode): string {
  const tokens: Record<string, unknown> = {};
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
    tokens.color = {
      value: n.fill,
      type: "color",
    };
  }
  if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint) {
    tokens.border = {
      color: { value: n.strokePaint, type: "color" },
      width: { value: `${n.strokeWidth}px`, type: "dimension" },
    };
  }
  tokens.size = {
    width: { value: `${Math.round(n.w)}px`, type: "dimension" },
    height: { value: `${Math.round(n.h)}px`, type: "dimension" },
  };
  if (n.cornerRadii && n.cornerRadii.some((r) => r > 0)) {
    tokens.borderRadius = {
      value: `${n.cornerRadii[0]}px`,
      type: "dimension",
    };
  }
  if (n.kind === "text") {
    tokens.typography = {
      fontSize: { value: `${n.fontSize}px`, type: "dimension" },
      fontWeight: { value: String(n.fontWeight), type: "fontWeight" },
    };
  }
  return JSON.stringify(tokens, null, 2);
}

function renderDevCode(n: XNode, format: DevFormat, unit: DevUnit): string {
  switch (format) {
    case "tailwind":
      return generateTailwind(n);
    case "swiftui":
      return generateSwiftUI(n);
    case "compose":
      return generateCompose(n);
    case "flutter":
      return generateFlutter(n);
    case "svg":
      return generateSvg(n);
    case "figma":
      return generateFigmaJson(n);
    case "tokens":
      return generateDesignTokens(n);
    default:
      return generateCss(n, unit);
  }
}

/** Language dropdown with the units setting underneath, as in Figma. */
function DevLangMenu({
  format,
  setFormat,
  unit,
  setUnit,
  showUnits,
}: {
  format: DevFormat;
  setFormat: (f: DevFormat) => void;
  unit: DevUnit;
  setUnit: (u: DevUnit) => void;
  showUnits: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => (open ? armPopover() : undefined), [open]);
  const current = DEV_LANGS.find((l) => l.id === format)?.label ?? "CSS";
  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  return (
    <div className="dev-lang" ref={root}>
      <button className="dev-lang-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {current}
        {showUnits && <span className="dev-lang-unit">{unit}</span>}
        <span className={`dev-lang-caret${open ? " up" : ""}`}>
          <Icon name="chevron-down" size={caretSize()} />
        </span>
      </button>
      {open && (
        <div className="dev-menu" role="menu">
          <p className="menu-label">Language</p>
          {DEV_LANGS.map((l) => (
            <button
              key={l.id}
              role="menuitemradio"
              aria-checked={l.id === format}
              className={l.id === format ? "on" : ""}
              onClick={pick(() => setFormat(l.id))}
            >
              {l.label}
              <span className="dev-menu-note">{l.lang}</span>
            </button>
          ))}
          {showUnits && (
            <>
              <p className="menu-label">Units</p>
              {(["px", "rem"] as DevUnit[]).map((u) => (
                <button
                  key={u}
                  role="menuitemradio"
                  aria-checked={u === unit}
                  className={u === unit ? "on" : ""}
                  onClick={pick(() => setUnit(u))}
                >
                  {u === "px" ? "Pixels (px)" : "Root em (rem)"}
                  <span className="dev-menu-note">{u}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Figma's List view: property rows whose values copy on click. */
function DevList({ n, snap, unit }: { n: XNode; snap: Snapshot; unit: DevUnit }) {
  const rows = devProperties(n, snap, unit);
  const groups: { title: string; items: DevProp[] }[] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.title === r.group);
    if (!g) {
      g = { title: r.group, items: [] };
      groups.push(g);
    }
    g.items.push(r);
  }
  return (
    <>
      {groups.map((g) => (
        <div key={g.title} className="insp-pad dev-group">
          <p className="dev-group-title">{g.title}</p>
          {g.items.map((r) => (
            <DevRow key={r.label} p={r} />
          ))}
        </div>
      ))}
    </>
  );
}

interface DevProp {
  group: string;
  label: string;
  value: string;
  swatch?: string;
}

function DevRow({ p }: { p: DevProp }) {
  return (
    <button
      className="dev-row"
      title="Copy value"
      onClick={() => {
        copyText(p.value);
        toast(`Copied ${p.label}`);
      }}
    >
      <span className="dev-k">{p.label}</span>
      {p.swatch && <span className="dev-sw" style={{ background: p.swatch }} />}
      <span className="dev-v">{p.value}</span>
      <Icon name="copy" size={11} />
    </button>
  );
}

function devProperties(n: XNode, snap: Snapshot, unit: DevUnit): DevProp[] {
  const out: DevProp[] = [];
  const L = (label: string, value: string, group = "Layout", swatch?: string) =>
    out.push({ group, label, value, swatch });
  L("Position", `${Math.round(n.x)}, ${Math.round(n.y)}`);
  L("Size", `${devLen(n.w, unit)} × ${devLen(n.h, unit)}`);
  if (n.rotation) L("Rotation", `${Math.round(n.rotation * 100) / 100}°`);
  if (n.flipH || n.flipV) L("Flip", [n.flipH && "Horizontal", n.flipV && "Vertical"].filter(Boolean).join(", "));
  L("Constraints", `${n.constraintH} / ${n.constraintV}`);
  if (n.layout) {
    const [pl, pr, pt, pb] = n.layout.padding;
    L("Direction", n.layout.direction === "horizontal" ? "Row" : "Column");
    if (n.layout.gap) L("Gap", devLen(n.layout.gap, unit));
    L("Padding", [pl, pr, pb, pt].map((v) => devLen(v, unit)).join(" "));
    if (n.layout.wrap) L("Wrap", "Enabled");
  }
  if (n.sizingW !== "fixed" || n.sizingH !== "fixed") {
    const size = (v: string) => (v === "hug" ? "Hug" : v === "fill" ? "Fill" : "Fixed");
    L("Sizing", `${size(n.sizingW)} / ${size(n.sizingH)}`);
  }
  if (n.opacity < 1) L("Opacity", `${Math.round(n.opacity * 100)}%`, "Layer");
  if (n.blendMode && n.blendMode !== "normal") L("Blend mode", n.blendMode, "Layer");
  if (n.isMask) L("Mask", n.maskType === "luminance" ? "Luminance" : "Alpha", "Layer");
  const fills = (n.fills ?? []).filter((f) => f.visible !== false);
  // Same reading order as the Design panel now uses: the paints stacked above
  // the base fill come first, so both sides count the stack from the canvas down.
  for (const f of [...fills].reverse()) {
    if (isNone(f.color)) continue;
    const label = f.type === "solid" ? "Fill" : f.type.replace("-", " ").replace(/^./, (c) => c.toUpperCase());
    L(label, `${f.color.toUpperCase()} · ${Math.round((f.opacity ?? 1) * 100)}%`, "Style", f.color);
  }
  if (n.fillVisible && !isNone(n.fill)) {
    L("Fill", `${n.fill.toUpperCase()} · ${Math.round((n.fillOpacity ?? 1) * 100)}%`, "Style", n.fill);
  }
  if (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)) {
    L(
      "Border",
      `${
        (n.strokeSides ?? "all") === "custom"
          ? sideWidths("custom", n.strokeSideW, n.strokeWidth).map((w) => devLen(w, unit)).join(" ")
          : (n.strokeSides ?? "all") !== "all"
            ? `${devLen(n.strokeWidth, unit)} ${n.strokeSides} only`
            : devLen(n.strokeWidth, unit)
      } ${n.strokeAlign} ${n.strokePaint.toUpperCase()}`,
      "Style",
      n.strokePaint,
    );
  }
  if (n.strokeDash && n.strokeDash > 0) L("Dashed", `${n.strokeDash}`, "Style");
  for (const e of n.effects ?? []) {
    if (e.visible === false) continue;
    if (e.kind === "drop-shadow" || e.kind === "inner-shadow") {
      L(
        e.kind === "drop-shadow" ? "Drop shadow" : "Inner shadow",
        `${e.x}, ${e.y} · blur ${e.blur}${e.spread ? ` · spread ${e.spread}` : ""} · ${e.color}${
          e.blend && e.blend !== "Normal" ? ` · ${e.blend}` : ""
        }`,
        "Style",
        e.color,
      );
    } else {
      L(e.kind === "layer-blur" ? "Layer blur" : "Blur", `${e.blur}`, "Style");
    }
  }
  if (n.cornerRadii?.some((r) => r > 0)) {
    if (n.cornerIndependent) {
      L("Corner radius", n.cornerRadii.map((r) => devLen(r, unit)).join(" "));
    } else {
      L("Corner radius", devLen(n.cornerRadii[0], unit));
    }
    if (n.cornerSmoothing) L("Corner smoothing", `${Math.round(n.cornerSmoothing * 100)}%`);
  }
  if (n.kind === "text") {
    L("Text", n.text || "", "Typography");
    L("Font", `${n.fontFamily} ${n.fontWeight}`, "Typography");
    L("Font size", devLen(n.fontSize, unit), "Typography");
    if (n.lineHeight) L("Line height", devLen(n.lineHeight, unit), "Typography");
    if (n.letterSpacing) L("Letter spacing", devLen(n.letterSpacing, unit), "Typography");
    if (n.textAlign && n.textAlign !== "left") L("Alignment", n.textAlign, "Typography");
    if (n.textAlignVertical && n.textAlignVertical !== "top")
      L("Vertical alignment", n.textAlignVertical, "Typography");
    if ((n.textWrap === "balance" || n.textWrap === "pretty")) L("Wrap style", n.textWrap, "Typography");
    if (n.listStyle && n.listStyle !== "none") L("List", n.listStyle, "Typography");
    if (n.paragraphIndent) L("Paragraph indent", devLen(n.paragraphIndent, unit), "Typography");
  }
  // Figma's "view applied styles": only paints are named here, matching the
  // two style slots the engine actually has.
  for (const [label, id] of [
    ["Fill style", n.fillStyle],
    ["Stroke style", n.strokeStyle],
  ] as [string, string | undefined][]) {
    if (!id) continue;
    const style = snap.styles.find((s) => s.id === id || s.name === id);
    L(label, style ? `${style.name} · ${style.color.toUpperCase()}` : String(id), "Styles", style?.color);
  }
  if (n.exports?.length) {
    L(
      "Export",
      n.exports.map((p) => `${p.format} ${p.scale}×${p.suffix ? ` ${p.suffix}` : ""}`).join(", "),
      "Export",
    );
  }
  return out;
}

/** Figma shows a typographic sample instead of the box model for text layers. */
function TypeSpecimen({ n }: { n: XNode }) {
  return (
    <div className="dev-type">
      <div
        className="dev-type-sample"
        style={{
          fontFamily: `${n.fontFamily}, Inter, system-ui, sans-serif`,
          fontSize: Math.min(28, Math.max(11, n.fontSize / 2)),
          fontWeight: n.fontWeight,
          lineHeight: n.lineHeight ? `${n.lineHeight / n.fontSize}` : 1.3,
          letterSpacing: n.letterSpacing ? `${n.letterSpacing}px` : undefined,
          color: n.fillVisible === false || isNone(n.fill) ? "var(--text)" : n.fill,
          textAlign: n.textAlign === "center" ? "center" : n.textAlign === "right" ? "right" : "left",
        }}
      >
        {(n.text || n.name).split("\n").slice(0, 3).join("\n")}
      </div>
      <div className="dev-type-meta">
        <span>
          {n.fontFamily} {n.fontWeight}
        </span>
        <span>
          {Math.round(n.fontSize)} / {n.lineHeight ? Math.round(n.lineHeight) : "auto"}
        </span>
      </div>
    </div>
  );
}

/** Component / instance information, with a route to the main component. */
function DevComponent({ n, engine, snap }: { n: XNode; engine: Engine; snap: Snapshot }) {
  const root = snap.pages[snap.page].root;
  const master = snap.components.find((c) => c.id === (n.componentId || n.id));
  const own = n.componentId ? find(root, n.componentId) : null;
  const instances = n.isComponent
    ? (() => {
        let count = 0;
        const walk = (p: XNode) => {
          for (const ch of p.children) {
            if (ch.componentId === n.id) count++;
            walk(ch);
          }
        };
        walk(root);
        return count;
      })()
    : 0;
  if (!n.isComponent && !n.componentId) return null;
  const props = Object.entries(n.componentProperties ?? {});
  return (
    <>
      <div className="hr" />
      <Section id="dev-component" title="Component" defaultOpen={true}>
        <div className="insp-pad dev-group">
          {n.componentId && (
            <button
              className="dev-row link"
              title="Select the main component"
              onClick={() => {
                const id = n.componentId;
                if (own || master) {
                  engine.dispatch({ type: "select", ids: [id] });
                  toast(`Selected ${master?.name ?? "main component"}`);
                } else {
                  toast("Main component is on another page");
                }
              }}
            >
              <span className="dev-k">Instance of</span>
              <span className="dev-v">{master?.name ?? "Component"}</span>
              <Icon name="chevron-right" size={11} />
            </button>
          )}
          {n.isComponent && (
            <DevRow p={{ group: "Component", label: "Instances", value: `${instances} on this page` }} />
          )}
          {n.variant && <DevRow p={{ group: "Component", label: "Variant", value: n.variant }} />}
          {master && master.variants.length > 0 && (
            <DevRow
              p={{ group: "Component", label: "Variants", value: master.variants.map((v) => v.name).join(", ") }}
            />
          )}
          {props.map(([k, v]) => (
            <DevRow key={k} p={{ group: "Component", label: k, value: String(v) }} />
          ))}
          {master?.properties?.length ? (
            <p className="dev-note">
              {master.properties.length} {plural(master.properties.length, "property", "properties")} defined on the
              main component.
            </p>
          ) : null}
        </div>
      </Section>
    </>
  );
}

/** Everything exportable inside the selection, downloadable from the panel. */
function DevAssets({ n, engine }: { n: XNode; engine: Engine }) {
  const items = collectExportables(n);
  if (!items.length) return null;
  return (
    <>
      <div className="hr" />
      <Section id="dev-assets" title={`Assets · ${items.length}`} defaultOpen={true}>
        <div className="insp-pad dev-assets">
          {items.map((a) => {
            const p = a.exports?.[0] ?? { format: "PNG" as const, scale: 1, suffix: "" };
            return (
              <div className="dev-asset" key={a.id}>
                <img className="xrow-thumb" src={previewUrl(a, { ...p, scale: 0.2 })} alt="" />
                <button
                  className="dev-asset-name"
                  title="Select on canvas"
                  onClick={() => {
                    engine.dispatch({ type: "select", ids: [a.id] });
                    zoomTo(engine, "selection");
                  }}
                >
                  {a.name}
                </button>
                <span className="dev-asset-size">
                  {Math.round(a.w)} × {Math.round(a.h)}
                </span>
                <button className="mini" title={`Download ${p.format}`} onClick={() => runExport(a, p)}>
                  <Icon name="arrow-downward" size={12} />
                </button>
              </div>
            );
          })}
          <button
            className="export-run"
            onClick={() => {
              items.forEach((a, i) =>
                window.setTimeout(() => runExport(a, a.exports?.[0] ?? { format: "PNG", scale: 1, suffix: "" }), i * 220),
              );
              toast(`Exporting ${plural(items.length, "asset")}`);
            }}
          >
            Download all
          </button>
        </div>
      </Section>
    </>
  );
}

/** Prototype interactions on the layer — Figma lists them with a jump. */
function DevInteractions({ n, engine, snap }: { n: XNode; engine: Engine; snap: Snapshot }) {
  const list = n.interactions ?? [];
  if (!list.length) return null;
  const root = snap.pages[snap.page].root;
  return (
    <>
      <div className="hr" />
      <Section id="dev-interactions" title={`Interactions · ${list.length}`} defaultOpen={true}>
        <div className="insp-pad dev-group">
          {list.map((it, i) => {
            const dest = it.destination ? find(root, it.destination) : null;
            return (
              <div className="dev-row" key={i}>
                <span className="dev-k">{devLabel(it.trigger)}</span>
                <span className="dev-v">
                  {devLabel(it.action)}
                  {dest ? ` → ${dest.name}` : ""}
                  {it.duration ? ` · ${it.duration}ms` : ""}
                </span>
                {dest && (
                  <button
                    className="mini"
                    title="Go to destination"
                    onClick={() => {
                      engine.dispatch({ type: "select", ids: [dest.id] });
                      zoomTo(engine, "selection");
                    }}
                  >
                    <Icon name="chevron-right" size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}

/**
 * Annotations. Figma lets a note pin a property so the value travels with the
 * callout; here the + menu writes the property text into the note, which keeps
 * the model a single string (and the canvas marker unchanged).
 */
function DevAnnotations({ n, engine, snap }: { n: XNode; engine: Engine; snap: Snapshot }) {
  const [note, setNote] = useState("");
  const [pin, setPin] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // ⇧T lands here, so the caret should already be in the note field.
  useEffect(() => {
    const on = () => input.current?.focus();
    window.addEventListener("x-native-annotate", on);
    return () => window.removeEventListener("x-native-annotate", on);
  }, []);
  // While the property menu is open it owns Escape, like the language menu.
  useEffect(() => (pin ? armPopover() : undefined), [pin]);
  const list = (snap.annotations ?? []).filter((a) => a.nodeId === n.id) ?? [];
  const pins: [string, () => string][] = [
    ["Fill", () => (n.fillVisible === false || isNone(n.fill) ? "Fill: none" : `Fill: ${n.fill.toUpperCase()}`)],
    ["Border", () => `Border: ${n.strokeWidth}px ${n.strokePaint.toUpperCase()}`],
    ["Size", () => `Size: ${Math.round(n.w)} × ${Math.round(n.h)}`],
    ["Position", () => `Position: ${Math.round(n.x)}, ${Math.round(n.y)}`],
    ["Radius", () => `Radius: ${n.cornerRadii.join(" ")}`],
    ["Font", () => `Font: ${n.fontFamily} ${n.fontSize}/${n.lineHeight || "auto"}`],
  ];
  const add = () => {
    const text = note.trim();
    if (!text) return;
    engine.dispatch({
      type: "addAnnotation",
      annotation: {
        id: `ann_${Date.now().toString(36)}`,
        nodeId: n.id,
        note: text,
        author: "You",
        date: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
    });
    setNote("");
    toast(`Annotation pinned to ${n.name}`);
  };
  return (
    <>
      <div className="hr" />
      <div className="h-row">
        <h3>Annotations</h3>
        <span className="grow" />
        <span className="sc">{list.length}</span>
      </div>
      <div className="insp-pad dev-annos">
        {list.map((a) => (
          <div className="dev-anno" key={a.id}>
            <span className="dev-anno-dot" aria-hidden />
            <div className="dev-anno-body">
              <p>{a.note}</p>
              <span className="dev-anno-meta">
                {a.author ?? "You"}
                {a.date ? ` · ${a.date}` : ""}
              </span>
            </div>
            <button
              className="mini"
              title="Delete annotation"
              onClick={() => engine.dispatch({ type: "deleteAnnotation", id: a.id })}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
        <div className="dev-anno-add">
          <input
            ref={input}
            placeholder="Add a note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <div className="dev-pin">
            <button className="mini" title="Pin a property" aria-expanded={pin} onClick={() => setPin((v) => !v)}>
              <Icon name="plus" size={rowIconSize()} />
            </button>
            {pin && (
              <div className="dev-menu right">
                <p className="menu-label">Add property</p>
                {pins.map(([label, get]) => (
                  <button
                    key={label}
                    onClick={() => {
                      const t = get();
                      setNote((v) => (v.trim() ? `${v.trim()}\n${t}` : t));
                      setPin(false);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="mini primary" title="Post annotation" onClick={add}>
            <Icon name="check" size={rowIconSize()} />
          </button>
        </div>
        <p className="dev-note">Markers show on the canvas as green dots while Dev Mode is on.</p>
      </div>
    </>
  );
}

/** "closeOverlay" reads as code; the panel lists intent, so split the camelCase. */
function devLabel(v: string): string {
  return (v || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Layers that can be exported: frames, slices and anything with settings. */
function collectExportables(n: XNode): XNode[] {
  const out: XNode[] = [];
  const walk = (p: XNode) => {
    for (const ch of p.children) {
      if (ch.visible === false) continue;
      if (ch.kind === "frame" || (ch.exports?.length ?? 0) > 0) out.push(ch);
      else walk(ch);
    }
  };
  walk(n);
  return out;
}
function Design({
  n,
  x,
  y,
  engine,
  snap,
}: {
  n: XNode;
  x: number;
  y: number;
  engine: Engine;
  snap: Snapshot;
}) {
  const [typeOpen, setTypeOpen] = useState(false);
  /** Which fill row the pointer picked up, and the row it is over. Only fills
   *  are reorderable: the base fill is the bottom of the stack by definition, so
   *  the rows above it are the ones a designer moves around. */
  const [fillDrag, setFillDrag] = useState<number | null>(null);
  const [fillOver, setFillOver] = useState<number | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [conOpen, setConOpen] = useState(false);
  const [cornersOpen, setCornersOpen] = useState(!!n.cornerIndependent);
  // An instance inherits its corners; Figma rejects individual radii there.
  /* Figma locks a handful of properties on a layer that lives inside an
   * instance: individual corner radii here, and the aspect-ratio lock and the
   * Scale tool below. All three ask the same question, so they share one
   * answer. */
  const inInstance = insideInstance(snap.pages[snap.page].root, n.id);
  /* Auto layout answers three questions the panel asks in several places: is
   * the gap on Auto, does this flow wrap, and is a declared hug still a hug
   * once something inside it is filling the same axis. */
  const isGrid = n.layout?.direction === "grid";
  const autoGap = n.layout ? isAutoGap(n.layout) : false;
  const wrapOn = n.layout ? wraps(n.layout) : false;
  const resolved = n.layout ? effectiveSizing(n.layout, n, n.children) : null;
  /* Figma: "the parent frame will no longer hug contents and become Fixed for
   * the axis" - so the resizing menu shows Fixed, and says why. */
  /* The two fields ask by *dimension*, not by axis. A vertical flow's main axis
   * is its height, so asking for "main" in the W field would show - and edit -
   * the height's answer. */
  const axisFor = (dim: "width" | "height"): "main" | "cross" => {
    const horiz = n.layout ? widthIsMain(n.layout) : true;
    return (dim === "width") === horiz ? "main" : "cross";
  };
  const showSizing = (dim: "width" | "height") => {
    const own = dim === "width" ? n.sizingW : n.sizingH;
    if (n.layout && n.kind !== "text") {
      // A layer that fills says so, and the layout's own hug answer only
      // applies to the axes the layer is not filling along.
      if (own === "fill") return "fill" as Sizing;
      return resolved![axisFor(dim)];
    }
    return own;
  };
  /* When that happens the label says so, so a frame that stopped hugging is
   * not mistaken for a bug in the resize itself. */
  const hugNote = (dim: "width" | "height") => {
    if (!n.layout || n.kind === "text") return undefined;
    const axis = axisFor(dim);
    const horiz = widthIsMain(n.layout);
    const wants = (axis === "main" ? n.layout.sizing : n.layout.cross) === "hug";
    const nodeWants = (dim === "width" ? n.sizingW : n.sizingH) === "hug";
    if ((!wants && !nodeWants) || showSizing(dim) !== "fixed") return undefined;
    return hasFillChild(n.children, axis, horiz)
      ? `a child fills the ${dim}, so the frame is Fixed here instead of hugging`
      : undefined;
  };
  /* Choosing Fixed or Hug - or Fill, which is not a hug - writes the answer on
   * the axis that dimension belongs to, so the layout's own pair cannot snap
   * the frame back over what the menu just said. */
  const setSizingAxis = (dim: "width" | "height", sizing: Sizing) => {
    if (!n.layout) return;
    const key = (dim === "width") === widthIsMain(n.layout) ? "sizing" : "cross";
    engine.dispatch({
      type: "autoLayout",
      id: n.id,
      layout: { ...n.layout, [key]: sizing === "hug" ? "hug" : "fixed" },
    });
  };
  const [strokeMore, setStrokeMore] = useState(n.strokeDash > 0);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const multi = snap.selection.length > 1;
  const [scaleAnchor, setScaleAnchor] = useState<ScaleAnchor>("mc");
  /* Figma keeps min and max behind the resizing menu: "Add min/max width and
   * height" puts the four fields in the panel, "Remove min and max" takes them
   * away again, and a layer that has none shows none. Tracked per layer, so the
   * fields come back only for the layer that asked for them. */
  const [minMaxOpen, setMinMaxOpen] = useState<Record<string, boolean>>({});
  const hasMinMax = n.minW != null || n.maxW != null || n.minH != null || n.maxH != null;
  const showMinMax = !!minMaxOpen[n.id] || hasMinMax;
  /* The Scale tool multiplies the box and everything inside it - stroke weights,
   * corner radii, type sizes, effects, auto layout gaps - while a plain resize
   * re-applies the parent's constraints. Both end up in the engine's `resize`,
   * which owns that difference, so the panel only has to choose the numbers. */
  const applyScale = (f: number) => {
    if (!Number.isFinite(f) || f <= 0 || f === 1) return;
    const root = snap.pages[snap.page].root;
    const picked = snap.selection
      .map((id) => find(root, id))
      .filter((m): m is XNode => !!m && !m.locked);
    if (!picked.length) {
      toast("Nothing to scale · the selection is empty or locked");
      return;
    }
    // Figma scales "any object, with the exception of locked layers and layers
    // nested inside a component instance" - scaling children of an instance
    // would multiply overrides the instance does not own.
    const nested = picked.filter((m) => insideInstance(root, m.id));
    if (nested.length) {
      toast(
        nested.length > 1
          ? `Not scalable · ${nested.length} layers are inside an instance`
          : "Not scalable · this layer is inside an instance",
      );
      return;
    }
    const boxes = picked.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h }));
    const next = scaleMembers(unionBox(boxes), boxes, f, scaleAnchor);
    engine.dispatch({ type: "begin" });
    picked.forEach((m, i) =>
      engine.dispatch({ type: "resize", id: m.id, ...next[i], scaleProps: true }),
    );
    engine.dispatch({ type: "end" });
    toast(`Scaled ${SCALE_LABEL(f)}${picked.length > 1 ? ` · ${plural(picked.length, "layer")}` : ""}`);
  };
  const num = (
    key: "x" | "y" | "w" | "h" | "rotation" | "opacity" | "fontSize" | "letterSpacing" | "lineHeight" | "paragraphSpacing",
    v: number,
  ) => {
    if (key === "x" || key === "y") {
      engine.dispatch({
        type: "move",
        ids: [n.id],
        dx: key === "x" ? v - x : 0,
        dy: key === "y" ? v - y : 0,
      });
      return;
    }
    if (key === "w" || key === "h") {
      let w = key === "w" ? v : n.w;
      let h = key === "h" ? v : n.h;
      // The Scale tool's fields are ratio-bound by definition, whether or not the
      // layer carries an aspect lock.
      if (snap.tool === "scale" && n.w > 0 && n.h > 0) {
        const box = sizeKeepingRatio({ x: n.x, y: n.y, w: n.w, h: n.h }, key === "w" ? { w: v } : { h: v });
        w = box.w;
        h = box.h;
      } else if (n.aspectLocked) {
        const ratio = n.aspectRatio && n.aspectRatio > 0 ? n.aspectRatio : n.w > 0 && n.h > 0 ? n.h / n.w : 1;
        if (key === "w") h = Math.max(1, v * ratio);
        else w = Math.max(1, v / ratio);
      }
      engine.dispatch({ type: "resize", id: n.id, x: n.x, y: n.y, w, h });
      // The axis that is still set to hug follows what was just typed.
      if (key === "w") refitHug({ w, sizingW: "fixed" }, { h: n.sizingH === "hug" });
      else refitHug({ h, sizingH: "fixed" }, { w: n.sizingW === "hug" });
      return;
    }
    if (key === "rotation") {
      // Turning a layer turns it about its rotation origin, so a moved origin
      // means the box has to slide as well. The arithmetic is the canvas's.
      const turned = rotateAboutOrigin(
        { x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation },
        n.rotOrigin ?? [0.5, 0.5],
        v,
      );
      engine.dispatch({
        type: "patch",
        id: n.id,
        patch: { x: turned.x, y: turned.y, rotation: turned.rotation },
      });
      return;
    }
    const next = key === "opacity" ? Math.max(0, Math.min(1, v)) : v;
    engine.dispatch({ type: "patch", id: n.id, patch: { [key]: next } });
    if (key === "fontSize" || key === "letterSpacing" || key === "lineHeight" || key === "paragraphSpacing")
      refitHug({ [key]: next });
  };
  const kindLabel = n.imageSrc
    ? "Image"
    : n.isComponent
      ? "Component"
      : n.componentId
        ? "Instance"
        : n.kind === "rect"
          ? "Rectangle"
          : n.kind[0].toUpperCase() + n.kind.slice(1);
  const patch = (p: Partial<XNode>) => engine.dispatch({ type: "patch", id: n.id, patch: p });
  /* Figma re-fits a text layer the moment a resizing mode is chosen, and after
   * any type metric that changes how much room the copy needs. The flags and
   * the box have to travel in the same patch: sizing alone leaves a stale box
   * up to the next keystroke. */
  const setSizing = (sizingW: Sizing, sizingH: Sizing) =>
    patch({ sizingW, sizingH, ...hugSize({ ...n, sizingW, sizingH } as XNode, n.text) });
  /** A type metric moved: apply it, then re-hug the axes that follow it. */
  const patchType = (over: Partial<XNode>) => {
    patch(over);
    refitHug(over);
  };
  /** Move a fill within the extra stack; `to` is an index into the same array. */
  const moveFill = (from: number, to: number) => {
    const list = [...(n.fills ?? [])];
    if (from === to || from < 0 || from >= list.length) return;
    const [item] = list.splice(from, 1);
    if (!item) return;
    list.splice(Math.max(0, Math.min(list.length, to)), 0, item);
    patch({ fills: list });
  };
  /* A min or max is a limit the hugging axes have to be measured against: each
   * keystroke clamps the box, and without a re-fit a limit typed as "200" would
   * leave the width at the "2" the first keystroke clamped it to. */
  const refitHug = (over: Partial<XNode>, axes?: { w?: boolean; h?: boolean }) => {
    if (n.kind !== "text") return;
    const fit = hugSize({ ...n, ...over } as XNode, n.text, axes);
    if (fit.w === undefined && fit.h === undefined) return;
    patch(fit);
  };
  const parent = findParent(snap.pages[snap.page].root, n.id);
  const hasAutoLayoutParent = !!parent?.layout;
  const gridParent = parent?.layout?.direction === "grid";
  /* First press turns the base stroke on; after that each press stacks another
     stroke on top, the way Figma's Stroke "+" behaves. Shared by the header "+"
     and the empty-state row so both paths do exactly the same thing. */
  const addStroke = () => {
    openSection("stroke");
    const hasBase = n.strokeWidth > 0 && (!isNone(n.strokePaint) || n.strokeVisible);
    if (!hasBase) {
      patch({
        strokePaint: isNone(n.strokePaint) ? "#1e1e1e" : n.strokePaint,
        strokeVisible: true,
        strokeWidth: n.strokeWidth || 1,
      });
      return;
    }
    patch({
      strokes: [...(n.strokes ?? []), { color: "#1e1e1e", opacity: 1, visible: true, width: 1, align: n.strokeAlign }],
    });
  };
  return (
    <>
      <div className="layer-type">
        <span className="kind">{kindLabel}</span>
        <span className="grow" />
        <button
          className={`icon-btn${n.visible ? "" : " on"}`}
          title={n.visible ? "Hide" : "Show"}
          onClick={() => engine.dispatch({ type: "hideSel" })}
        >
          <Icon name={n.visible ? "eye" : "eye-off"} size={14} />
        </button>
        <button
          className={`icon-btn${n.locked ? " on" : ""}`}
          title={n.locked ? "Unlock" : "Lock"}
          onClick={() => engine.dispatch({ type: "lockSel" })}
        >
          <Icon name={n.locked ? "lock" : "unlock"} size={14} />
        </button>
        <Tooltip label="Round to whole pixels" shortcut="⇧⌘P">
          <button
            className={`icon-btn${isFractional(n) ? " warn" : ""}`}
            title="Round to whole pixels"
            aria-label="Round to whole pixels"
            onClick={() => roundToPixel(engine)}
          >
            <Icon name="grid" size={14} />
          </button>
        </Tooltip>
        <button
          className="icon-btn"
          title="Dev Mode"
          onClick={() => engine.dispatch({ type: "setRightTab", tab: "inspect" })}
        >
          <Icon name="dev" size={14} />
        </button>
        <button
          className="icon-btn"
          title="More"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMore({ x: r.right - 220, y: r.bottom + 4 });
          }}
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      {more && (
        <ContextMenu
          x={more.x}
          y={more.y}
          items={[
            { kind: "action", id: "copy", label: "Copy", shortcut: "⌘C", icon: "copy" },
            { kind: "action", id: "duplicate", label: "Duplicate", shortcut: "⌘D", icon: "copy" },
            { kind: "action", id: "copyCode", label: `Copy as ${devLangLabel(getDevPrefs().format)}`, icon: "code" },
            { kind: "sep" },
            { kind: "action", id: "lockSel", label: "Lock/Unlock", shortcut: "⇧⌘L", icon: "lock" },
            { kind: "action", id: "hideSel", label: "Show/Hide", shortcut: "⇧⌘H", icon: "eye" },
            { kind: "action", id: "delete", label: "Delete", shortcut: "⌫", icon: "trash" },
          ]}
          onRun={(id) => runMenu(engine, id)}
          onClose={() => setMore(null)}
        />
      )}

      {multi && (
        <>
          <div className="h-row">
            <h3>Boolean</h3>
          </div>
          <div className="insp-pad">
            <div className="seg icons">
              {(["union", "subtract", "intersect", "exclude"] as const).map((op) => (
                <button
                  key={op}
                  title={`Boolean ${op[0].toUpperCase() + op.slice(1)}`}
                  onClick={() => engine.dispatch({ type: "boolean", op })}
                >
                  <Icon name={`boolean-${op}`} size={16} />
                </button>
              ))}
            </div>
            <button
              style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              onClick={() => engine.dispatch({ type: "flatten" })}
            >
              <Icon name="flatten" size={14} />
              <span>Flatten</span>
            </button>
          </div>
        </>
      )}

      <Section
        id="position"
        title="Position"
        actions={
          hasAutoLayoutParent ? (
            <button
              className={`plus${n.absolutePosition ? " on" : ""}`}
              title={n.absolutePosition ? "In auto layout flow" : "Absolute position (exclude from auto layout flow)"}
              onClick={() => patch({ absolutePosition: !n.absolutePosition })}
            >
              <Icon name="absolute" size={14} />
            </button>
          ) : undefined
        }
      >
      <div className="insp-pad">
        <div className="align">
          <div className="g">
            {(["align-left", "align-hcenter", "align-right"] as const).map((ic) => (
              <Tooltip key={ic} label={ALIGN_LABEL[ic]} shortcut={ALIGN_SHORTCUT[ic]}>
                <button aria-label={ALIGN_LABEL[ic]} onClick={(e) => align(engine, snap, ic, e.shiftKey)}>
                  <Icon name={ic} />
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="g">
            {(["align-top", "align-vcenter", "align-bottom"] as const).map((ic) => (
              <Tooltip key={ic} label={ALIGN_LABEL[ic]} shortcut={ALIGN_SHORTCUT[ic]}>
                <button aria-label={ALIGN_LABEL[ic]} onClick={(e) => align(engine, snap, ic, e.shiftKey)}>
                  <Icon name={ic} />
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="g">
            <Tooltip label="Distribute horizontal spacing" shortcut="⌃⌥H">
            <button aria-label="Distribute horizontal" onClick={() => engine.dispatch({ type: "distribute", axis: "h" })}>
              <Icon name="distribute-h" />
            </button>
            </Tooltip>
            <Tooltip label="Distribute vertical spacing" shortcut="⌃⌥V">
            <button aria-label="Distribute vertical" onClick={() => engine.dispatch({ type: "distribute", axis: "v" })}>
              <Icon name="distribute-v" />
            </button>
            </Tooltip>
            <Tooltip label="Tidy up" shortcut="⌃⌥⇧T">
            <button aria-label="Tidy up" onClick={() => { engine.dispatch({ type: "tidyUp" }); toast("Tidied up selection"); }}>
              <Icon name="grid" size={14} />
            </button>
            </Tooltip>
          </div>
        </div>
        <div className="grid3">
          <Field label="X" value={x} onChange={(v) => num("x", v)} />
          <Field label="Y" value={y} onChange={(v) => num("y", v)} />
          <button
            className={`icon-btn${conOpen ? " on" : ""}`}
            title="Constraints"
            onClick={() => setConOpen((v) => !v)}
          >
            <Icon name="constraints" size={14} />
          </button>
          <Field icon="rotate" aria="Rotation" value={n.rotation} onChange={(v) => num("rotation", v)} />
          <div className="seg icons">
            <button
              title="Flip horizontal"
              onClick={() => engine.dispatch({ type: "flip", axis: "h" })}
            >
              <Icon name="flip-h" size={14} />
            </button>
            <button title="Flip vertical" onClick={() => engine.dispatch({ type: "flip", axis: "v" })}>
              <Icon name="flip-v" size={14} />
            </button>
          </div>
        </div>
        {conOpen && (
          <Constraints
            h={n.constraintH}
            v={n.constraintV}
            onChange={(axis, value) => patch(axis === "h" ? { constraintH: value } : { constraintV: value })}
          />
        )}
      </div>
      </Section>

      <div className="hr" />
      <Section id="layout" title="Layout" actions={
        <div style={{ display: "flex", gap: 2 }}>
          {/* Figma's two ways in: add an auto layout frame with the defaults, or
              let Figma work the values out from how the objects already sit. */}
          {!n.layout && (
            <button
              className="plus"
              title="Suggest auto layout (⌃⇧A)"
              onClick={() => suggestAutoLayout(engine, snap, n.id)}
            >
              <Icon name="magic-noodle" size={14} />
            </button>
          )}
          <button
            className="plus"
            // Add auto layout (⇧A) wraps a layer that cannot hold a layout in a
            // frame; remove refuses on an instance, saying so.
            title={n.layout ? "Remove auto layout (⌥⇧A)" : "Add auto layout (⇧A)"}
            onClick={() => (n.layout ? removeAutoLayout(engine, snap, n.id) : addAutoLayout(engine, snap, n.id))}
          >
            <Icon name={n.layout ? "minus" : "plus"} size={14} />
          </button>
        </div>
      }>
      <div className="dir-row">
        <div className="seg icons">
          <button
            className={!n.layout ? "on" : ""}
            // "In the right sidebar, click Freeform or Remove auto layout."
            title="Freeform (remove auto layout, ⌥⇧A)"
            onClick={() => removeAutoLayout(engine, snap, n.id)}
          >
            <Icon name="layout-none" />
          </button>
          <button
            className={n.layout?.direction === "vertical" ? "on" : ""}
            title="Vertical"
            onClick={() => setDir(engine, snap, n, "vertical")}
          >
            <Icon name="layout-v" />
          </button>
          <button
            className={n.layout?.direction === "horizontal" ? "on" : ""}
            title="Horizontal"
            onClick={() => setDir(engine, snap, n, "horizontal")}
          >
            <Icon name="layout-h" />
          </button>
          {/* The third flow: cells in columns and rows. Wrap is what a grid
              does not need, so choosing Grid leaves it out of the picture
              rather than doubling up on the horizontal flow - and switching
              back to Horizontal or Vertical drops the grid's own fields. */}
          <button
            className={n.layout?.direction === "grid" ? "on" : ""}
            title="Grid"
            onClick={() => setFlow(engine, snap, n.id, "grid")}
          >
            <Icon name="layout-grid" />
          </button>
          {/* Figma: "When you have the horizontal selected, Wrap becomes
              available." A vertical flow has no wrap to offer, so the button is
              shown disabled and says why rather than silently doing nothing. */}
          <button
            className={wrapOn ? "on" : ""}
            disabled={n.layout?.direction !== "horizontal"}
            title={
              n.layout?.direction !== "horizontal"
                ? "Wrap is available on a horizontal flow"
                : wrapOn
                  ? "Wrapping onto the next line"
                  : "Wrap onto the next line"
            }
            onClick={() =>
              n.layout &&
              engine.dispatch({
                type: "autoLayout",
                id: n.id,
                layout: { ...n.layout, wrap: !n.layout.wrap },
              })
            }
          >
            <Icon name="wrap" />
          </button>
        </div>
      </div>
      <div className="insp-pad">
        <div className="grid3">
          <Field
            label="W"
            hint={showSizing("width")}
            hintNote={hugNote("width")}
            value={n.w}
            onChange={(v) => num("w", v)}
            onLabelClick={() => {
              const sizingW = cycleSizing(n.sizingW);
              if (n.kind === "text") setSizing(sizingW, n.sizingH);
              else patch({ sizingW });
              setSizingAxis("width", sizingW);
            }}
          />
          <Field
            label="H"
            hint={showSizing("height")}
            hintNote={hugNote("height")}
            value={n.h}
            onChange={(v) => num("h", v)}
            onLabelClick={() => {
              const sizingH = cycleSizing(n.sizingH);
              if (n.kind === "text") setSizing(n.sizingW, sizingH);
              else patch({ sizingH });
              setSizingAxis("height", sizingH);
            }}
          />
          <button
            className={`icon-btn${n.aspectLocked ? " on" : ""}`}
            // Figma: the aspect ratio of a child layer of an instance "can be
            // adjusted from their respective main components".
            disabled={inInstance}
            title={
              inInstance
                ? "Aspect ratio comes from the main component"
                : n.aspectLocked
                  ? "Unlock aspect ratio"
                  : "Lock aspect ratio"
            }
            onClick={() => patch({ aspectLocked: !n.aspectLocked })}
          >
            <Icon name="aspect" size={14} />
          </button>
          <button
            className={`icon-btn${showMinMax ? " on" : ""}`}
            title={showMinMax ? "Remove min and max" : "Add min/max width and height"}
            onClick={() => {
              if (showMinMax) {
                setMinMaxOpen((v) => ({ ...v, [n.id]: false }));
                if (hasMinMax) patch({ minW: undefined, maxW: undefined, minH: undefined, maxH: undefined });
              } else {
                setMinMaxOpen((v) => ({ ...v, [n.id]: true }));
              }
            }}
          >
            <Icon name={showMinMax ? "minus" : "width-min"} size={14} />
          </button>
        </div>
        {snap.tool === "scale" && (
          <div className="scale-panel">
            <div className="scale-head">
              <span>Scale</span>
              <select
                aria-label="Scale multiplier"
                value=""
                title="Multiply the size of every selected layer, strokes and type included"
                onChange={(e) => {
                  const f = Number(e.target.value);
                  if (f) applyScale(f);
                }}
              >
                <option value="">Multiplier…</option>
                {SCALE_FACTORS.map((f) => (
                  <option key={f} value={f}>
                    {SCALE_LABEL(f)}
                  </option>
                ))}
              </select>
              <input
                className="scale-type"
                aria-label="Scale by"
                placeholder="×"
                title="Type a multiplier, e.g. 1.5, then press Enter"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const el = e.target as HTMLInputElement;
                  const f = parseFloat(el.value);
                  if (Number.isFinite(f) && f > 0) applyScale(f);
                  el.value = "";
                  el.blur();
                }}
                onBlur={(e) => {
                  const el = e.target as HTMLInputElement;
                  const f = parseFloat(el.value);
                  if (Number.isFinite(f) && f > 0) applyScale(f);
                  el.value = "";
                }}
              />
            </div>
            <div className="scale-anchor" role="group" aria-label="Scale anchor">
              {SCALE_ANCHORS.map((a) => (
                <button
                  key={a.id}
                  title={`${a.label} stays put`}
                  aria-label={`Scale from the ${a.label.toLowerCase()}`}
                  aria-pressed={scaleAnchor === a.id}
                  className={scaleAnchor === a.id ? "on" : ""}
                  onClick={() => setScaleAnchor(a.id)}
                />
              ))}
            </div>
            <span className="scale-note">
              Anchor sets which side holds while the multiplier or W/H change.
            </span>
          </div>
        )}
        {showMinMax && (
          <div className="grid2" style={{ marginTop: 4 }}>
            <Field label="Min W" value={n.minW || 0} onChange={(v) => { patch({ minW: v > 0 ? v : undefined }); refitHug({ minW: v }); }} />
            <Field label="Max W" value={n.maxW || 0} onChange={(v) => { patch({ maxW: v > 0 ? v : undefined }); refitHug({ maxW: v }); }} />
            <Field label="Min H" value={n.minH || 0} onChange={(v) => { patch({ minH: v > 0 ? v : undefined }); refitHug({ minH: v }); }} />
            <Field
              label="Max H"
              value={n.maxH || 0}
              onChange={(v) => {
                patch(n.kind === "text" ? { maxH: v > 0 ? v : undefined, maxLines: 0 } : { maxH: v > 0 ? v : undefined });
                refitHug({ maxH: v });
              }}
            />
          </div>
        )}
        {gridParent && (
          // "You can also use the Column span and Row span fields in the right
          // sidebar" - shown only for an object that lives in a grid.
          <div className="grid2" style={{ marginTop: 4 }}>
            <Field
              label="Col span"
              value={n.colSpan ?? 1}
              onChange={(v) => patch({ colSpan: Math.max(1, Math.round(v)) })}
            />
            <Field
              label="Row span"
              value={n.rowSpan ?? 1}
              onChange={(v) => patch({ rowSpan: Math.max(1, Math.round(v)) })}
            />
          </div>
        )}
        {hasAutoLayoutParent && (
          <label className="check" style={{ marginTop: 6, paddingLeft: 0 }}>
            <input
              type="checkbox"
              checked={!!n.absolutePosition}
              onChange={(e) => patch({ absolutePosition: e.target.checked })}
            />
            Ignore auto layout
          </label>
        )}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={n.overflow !== "visible"}
          onChange={(e) =>
            engine.dispatch({
              type: "patch",
              id: n.id,
              patch: { overflow: e.target.checked ? "clip" : "visible" },
            })
          }
        />
        Clip content / mask
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={!!n.isMask}
          onChange={(e) => patch({ isMask: e.target.checked })}
        />
        Use as mask
      </label>
      {n.isMask && (
        <div className="insp-pad">
          <div className="field">
            <select
              value={n.maskType || "alpha"}
              onChange={(e) => patch({ maskType: e.target.value as XNode["maskType"] })}
            >
              <option value="alpha">Alpha</option>
              <option value="vector">Vector</option>
              <option value="luminance">Luminance</option>
            </select>
          </div>
        </div>
      )}
      <div className="insp-pad">
        <div className="seg">
          <button
            title="Convert to vector path"
            onClick={() => {
              if (n.kind !== "vector") engine.dispatch({ type: "flatten" });
            }}
          >
            Edit vector
          </button>
          <button onClick={() => engine.dispatch({ type: "flatten" })}>Flatten</button>
          {n.strokeWidth > 0 && (
            <button onClick={() => engine.dispatch({ type: "outlineStroke" })}>Outline stroke</button>
          )}
        </div>
      </div>
      {(n.kind === "vector" || n.path.length > 0) && (
        <div className="insp-pad" style={{ marginTop: 2 }}>
          <div style={{ padding: 10, background: "var(--hover)", borderRadius: 8, border: "1px solid var(--line)", display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 11 }}>Vector Network</strong>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {snap.vecEdit === n.id ? (
                  <button
                    className="export-run"
                    style={{ padding: "2px 8px", fontSize: 10, background: "var(--accent)", color: "#fff" }}
                    onClick={() => engine.dispatch({ type: "setVecEdit", id: null, pointIndex: null })}
                    title="Exit vector edit mode (Esc / ⌘↵)"
                  >
                    Done
                  </button>
                ) : (
                  <button
                    className="export-run"
                    style={{ padding: "2px 8px", fontSize: 10 }}
                    onClick={() => engine.dispatch({ type: "setVecEdit", id: n.id, pointIndex: 0 })}
                    title="Enter vector edit mode (↵)"
                  >
                    Edit Path
                  </button>
                )}
                <span style={{ fontSize: 9, padding: "2px 6px", background: "var(--accent)", color: "#fff", borderRadius: 10 }}>
                  Evan Wallace Graph
                </span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 10, color: "var(--dim)" }}>
              <div>Vertices: <strong style={{ color: "var(--text)" }}>{n.vectorNetwork?.vertices.length ?? n.path.length}</strong></div>
              <div>Segments: <strong style={{ color: "var(--text)" }}>{n.vectorNetwork?.segments.length ?? (n.path.length > 1 ? n.path.length - (n.closed ? 0 : 1) : 0)}</strong></div>
              <div>Branching (≥3): <strong style={{ color: "var(--text)" }}>{n.vectorNetwork ? n.vectorNetwork.vertices.filter((_, i) => vertexDegree(n.vectorNetwork!, i) >= 3).length : 0}</strong></div>
              <div>Closed: <strong style={{ color: "var(--text)" }}>{n.closed ? "Yes" : "No"}</strong></div>
            </div>

            {snap.vecEdit === n.id && (() => {
              const activePtIdx =
                snap.vecPoint !== null &&
                snap.vecPoint !== undefined &&
                snap.vecPoint >= 0 &&
                snap.vecPoint < n.path.length
                  ? snap.vecPoint
                  : (n.path.length > 0 ? 0 : null);
              const pt = activePtIdx !== null ? n.path[activePtIdx] : null;
              if (activePtIdx === null || !pt) return null;
              return (
                <div style={{ padding: 8, background: "var(--bg-subtle)", borderRadius: 6, border: "1px solid var(--border)", display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, fontWeight: 600 }}>Vertex #{activePtIdx + 1}</span>
                    <span style={{ fontSize: 10, color: "var(--dim)" }}>({Math.round(pt.x)}, {Math.round(pt.y)})</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 10, color: "var(--dim)" }}>Point Radius</span>
                    <input
                      type="number"
                      min={0}
                      value={pt.cornerRadius ?? 0}
                      style={{ width: 64, padding: "2px 4px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "inherit" }}
                      onChange={(e) => {
                        const r = parseFloat(e.target.value) || 0;
                        engine.dispatch({ type: "setPointCornerRadius", id: n.id, pointIndex: activePtIdx, radius: r });
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 10, color: "var(--dim)" }}>Vertex Mirror Mode</span>
                    <div className="seg" style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 10 }}>
                      <button
                        className={pt.mirrorMode === "none" || !pt.mirrorMode ? "on" : ""}
                        title="Independent handles / Sharp corner"
                        onClick={() => engine.dispatch({ type: "setPointMirror", id: n.id, pointIndex: activePtIdx, mode: "none" })}
                      >
                        Corner
                      </button>
                      <button
                        className={pt.mirrorMode === "angle" ? "on" : ""}
                        title="Mirror angle only, independent length"
                        onClick={() => engine.dispatch({ type: "setPointMirror", id: n.id, pointIndex: activePtIdx, mode: "angle" })}
                      >
                        Angle
                      </button>
                      <button
                        className={pt.mirrorMode === "angleAndLength" ? "on" : ""}
                        title="Symmetric mirror angle & length"
                        onClick={() => engine.dispatch({ type: "setPointMirror", id: n.id, pointIndex: activePtIdx, mode: "angleAndLength" })}
                      >
                        Mirror
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="export-run"
                style={{ flex: 1, padding: "4px 8px", fontSize: 10 }}
                onClick={() => {
                  const vn = n.vectorNetwork || pathToVectorNetwork(n.path, n.closed);
                  const svgD = vectorNetworkToSvgPath(vn);
                  copyText(svgD);
                  toast("Copied SVG Path");
                }}
              >
                Copy SVG Path
              </button>
              <button
                className="export-run"
                style={{ padding: "4px 8px", fontSize: 10 }}
                onClick={() => {
                  const smoothed = smoothPath(n.path, n.closed);
                  engine.dispatch({ type: "patchPath", id: n.id, path: smoothed, closed: n.closed });
                  toast("Smoothed vector handles");
                }}
              >
                Smooth
              </button>
              <button
                className="export-run"
                style={{ padding: "4px 8px", fontSize: 10 }}
                onClick={() => {
                  const simplified = simplifyPath(n.path, 1.5);
                  engine.dispatch({ type: "patchPath", id: n.id, path: simplified, closed: n.closed });
                  toast("Simplified vector path");
                }}
              >
                Simplify
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              <div style={{ fontSize: 10, color: "var(--dim)" }}>Global Symmetry:</div>
              <div className="seg" style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 10 }}>
                <button
                  title="Symmetric angle and length"
                  onClick={() => {
                    const newPath = n.path.map((p) => ({ ...p, mirrorMode: "angleAndLength" as const }));
                    engine.dispatch({ type: "patchPath", id: n.id, path: newPath, closed: n.closed });
                    toast("Handles: Mirrored (Angle & Length)");
                  }}
                >
                  Mirrored
                </button>
                <button
                  title="Mirror angle only, independent length"
                  onClick={() => {
                    const newPath = n.path.map((p) => ({ ...p, mirrorMode: "angle" as const }));
                    engine.dispatch({ type: "patchPath", id: n.id, path: newPath, closed: n.closed });
                    toast("Handles: Asymmetric Angle");
                  }}
                >
                  Asymmetric
                </button>
                <button
                  title="Independent angle and length (sharp corner)"
                  onClick={() => {
                    const newPath = n.path.map((p) => ({ ...p, mirrorMode: "none" as const }));
                    engine.dispatch({ type: "patchPath", id: n.id, path: newPath, closed: n.closed });
                    toast("Handles: Corner (Independent)");
                  }}
                >
                  Corner
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {(n.isComponent || n.componentId) && (() => {
        const master = snap.components.find((c) => c.id === n.componentId || c.node.id === n.componentId || (n.isComponent && (c.id === n.id || c.node.id === n.id)));
        const propDefs = master?.properties ?? [];
        return (
          <>
            <div className="h-row">
              <h3>{n.isComponent ? "Component" : "Instance"}</h3>
              <div style={{ display: "flex", gap: 4 }}>
                {n.componentId && (
                  <>
                    <button
                      className="icon-btn"
                      title="Go to main component"
                      onClick={() => {
                        if (master) {
                          engine.dispatch({ type: "select", ids: [master.node.id] });
                          toast("Navigated to main component");
                        }
                      }}
                    >
                      <Icon name="component" size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Reset all overrides"
                      onClick={() => {
                        engine.dispatch({ type: "resetOverrides", id: n.id });
                        toast("Overrides reset");
                      }}
                    >
                      <Icon name="reset" size={14} />
                    </button>
                    <select
                      style={{ width: 14, opacity: 0.6, border: 0, background: "transparent", cursor: "pointer", marginLeft: -4 }}
                      title="Reset specific override"
                      value=""
                      onChange={(e) => {
                        const val = e.target.value;
                        if (!val) return;
                        if (val === "all") engine.dispatch({ type: "resetOverrides", id: n.id });
                        else engine.dispatch({ type: "resetOverrides", id: n.id, property: val });
                        toast(`Reset ${val} override`);
                      }}
                    >
                      <option value="" disabled>▾</option>
                      <option value="fill">Reset fill</option>
                      <option value="stroke">Reset stroke</option>
                      <option value="text">Reset text</option>
                      <option value="w">Reset size</option>
                      <option value="all">Reset all</option>
                    </select>
                    <button
                      className="icon-btn"
                      title="Detach instance (⌥⌘B)"
                      onClick={() => {
                        engine.dispatch({ type: "detachInstance" });
                        toast("Instance detached");
                      }}
                    >
                      <Icon name="detach" size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="insp-pad">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Variant</span>
                <select
                  style={{ flex: 1, maxWidth: 140 }}
                  value={n.variant || "Default"}
                  onChange={(e) => engine.dispatch({ type: "setVariant", id: n.id, name: e.target.value })}
                >
                  {(master?.variants ?? [{ name: "Default" }]).map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>

              {propDefs.filter((p) => p.type !== "variant").map((prop) => {
                const currentVal = n.componentProperties?.[prop.name] ?? prop.defaultValue;
                return (
                  <div key={prop.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "var(--fg-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={prop.name}>
                      {prop.name}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {prop.type === "boolean" ? (
                        <input
                          type="checkbox"
                          checked={Boolean(currentVal)}
                          onChange={(e) =>
                            engine.dispatch({
                              type: "setComponentProperty",
                              id: n.id,
                              propName: prop.name,
                              value: e.target.checked,
                            })
                          }
                        />
                      ) : (
                        <input
                          type="text"
                          style={{ width: 110, padding: "2px 6px", fontSize: 11, background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 4, color: "inherit" }}
                          value={String(currentVal)}
                          onChange={(e) =>
                            engine.dispatch({
                              type: "setComponentProperty",
                              id: n.id,
                              propName: prop.name,
                              value: e.target.value,
                            })
                          }
                        />
                      )}
                      {n.isComponent && master && (
                        <button
                          className="icon-btn"
                          title={`Delete property "${prop.name}"`}
                          onClick={() => {
                            engine.dispatch({
                              type: "deleteComponentProperty",
                              componentId: master.id,
                              propId: prop.id,
                            });
                            toast(`Property "${prop.name}" deleted`);
                          }}
                          style={{ padding: 2, opacity: 0.6 }}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {n.isComponent && master && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button
                    style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                    onClick={() => {
                      const name = `Variant ${(master.variants?.length ?? 1) + 1}`;
                      engine.dispatch({ type: "addVariant", name });
                    }}
                  >
                    + Add variant
                  </button>
                  <button
                    style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                    onClick={() => {
                      const propType = prompt("Property type: boolean or text?", "boolean")?.toLowerCase();
                      if (propType === "boolean" || propType === "text") {
                        const propName = prompt(`Enter ${propType} property name (e.g. Show icon, Title):`);
                        if (propName) {
                          const targetLayer = prompt("Child layer name to bind to (optional):") || undefined;
                          engine.dispatch({
                            type: "addComponentProperty",
                            componentId: master.id,
                            property: {
                              id: `prop-${Date.now()}`,
                              name: propName,
                              type: propType,
                              defaultValue: propType === "boolean" ? true : "Text",
                              targetNodeName: targetLayer,
                            },
                          });
                          toast(`Added ${propType} property: ${propName}`);
                        }
                      }
                    }}
                  >
                    + Property
                  </button>
                </div>
              )}
            </div>
          </>
        );
      })()}
      {n.layout && (
        <>
          <div className="dir-row">
            {/* A grid has no single run of objects to pack - its objects are
                positioned by their cells - so the packing box is the grid's
                one exception. Per-cell alignment is on the object itself, in
                the Position section, as the grid article describes. */}
            {!isGrid && (
              <Nine
                layout={n.layout}
                onChange={(patch) =>
                  engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, ...patch } })
                }
              />
            )}
            <button
              className="icon-btn"
              title={n.layout.justify === "between" ? "Packed" : "Space between"}
              onClick={() =>
                engine.dispatch({
                  type: "autoLayout",
                  id: n.id,
                  layout: {
                    ...n.layout!,
                    justify: n.layout!.justify === "between" ? "min" : "between",
                  },
                })
              }
            >
              <Icon name="distribute-h" />
            </button>
            {n.layout.direction === "horizontal" && (
              <button
                className={`icon-btn${n.layout.align === "baseline" ? " on" : ""}`}
                title={n.layout.align === "baseline" ? "Baseline alignment active" : "Align to text baseline"}
                onClick={() =>
                  engine.dispatch({
                    type: "autoLayout",
                    id: n.id,
                    layout: {
                      ...n.layout!,
                      align: n.layout!.align === "baseline" ? "min" : "baseline",
                    },
                  })
                }
              >
                <Icon name="align-bottom" />
              </button>
            )}
          </div>
          {isGrid && (
            <GridPanel
              node={n}
              layout={n.layout}
              onChange={(patch) => engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, ...patch } })}
            />
          )}
          <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
            {isGrid ? (
              // A grid has a gap per axis rather than one gap and a packing
              // rule: "Gap between rows" and "Gap between columns".
              <div className="gap-row">
                <Field
                  icon="gap"
                  aria="Gap between columns"
                  value={n.layout.gapCols ?? n.layout.gap ?? 0}
                  onChange={(v) => engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, gapCols: v } })}
                />
                <Field
                  icon="padding-vertical"
                  aria="Gap between rows"
                  value={n.layout.gapRows ?? n.layout.gap ?? 0}
                  onChange={(v) => engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, gapRows: v } })}
                />
              </div>
            ) : (
            <div className="gap-row">
              {autoGap ? (
                <button
                  className="gap-mode"
                  title="Gap between items"
                  onClick={() => {
                    const modes = SPACING_MODES.map((m) => m.id);
                    const at = modes.indexOf((n.layout!.spacing ?? "between") as never);
                    engine.dispatch({
                      type: "autoLayout",
                      id: n.id,
                      layout: { ...n.layout!, spacing: modes[(at + 1) % modes.length] },
                    });
                  }}
                >
                  Auto &middot; {SPACING_MODES.find((m) => m.id === (n.layout!.spacing ?? "between"))?.label}
                </button>
              ) : (
                <Field
                  icon="gap"
                  aria="Gap between items"
                  value={n.layout.gap}
                  onChange={(v) =>
                    engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, gap: v } })
                  }
                />
              )}
              <button
                className={`icon-btn${autoGap ? " on" : ""}`}
                title={autoGap ? "Use a fixed gap" : "Set the gap to Auto"}
                onClick={() =>
                  engine.dispatch({
                    type: "autoLayout",
                    id: n.id,
                    layout: {
                      ...n.layout!,
                      gapMode: autoGap ? "fixed" : "auto",
                      spacing: n.layout!.spacing ?? "between",
                    },
                  })
                }
              >
                <Icon name="distribute-h" size={14} />
              </button>
            </div>
            )}
            {padOpen ? (
              <div className="grid2">
                {(["L", "R", "T", "B"] as const).map((lab, i) => (
                  <PadField
                    key={lab}
                    label={lab}
                    value={n.layout!.padding[i]}
                    onCommit={(v) => {
                      const p = [...n.layout!.padding] as [number, number, number, number];
                      p[i] = v;
                      engine.dispatch({
                        type: "autoLayout",
                        id: n.id,
                        layout: { ...n.layout!, padding: p },
                      });
                    }}
                  />
                ))}
              </div>
            ) : (
              // Figma's panel keeps the padding as a horizontal and a vertical
              // value by default - "Padding controls in the right panel are
              // separated into vertical (top and bottom) and horizontal (left
              // and right) by default" - and reads Mixed when the two sides of
              // a pair disagree. The four individual fields are one click away.
              <div className="grid2">
                <PadField
                  icon="padding-horizontal"
                  aria="Horizontal padding"
                  value={n.layout.padding[0]}
                  mixed={n.layout.padding[0] !== n.layout.padding[1] ? "Mixed" : undefined}
                  onCommit={(v) => {
                    const p = [...n.layout!.padding] as [number, number, number, number];
                    p[0] = v;
                    p[1] = v;
                    engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, padding: p } });
                  }}
                  onShorthand={(p) =>
                    engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, padding: p } })
                  }
                />
                <PadField
                  icon="padding-vertical"
                  aria="Vertical padding"
                  value={n.layout.padding[2]}
                  mixed={n.layout.padding[2] !== n.layout.padding[3] ? "Mixed" : undefined}
                  onCommit={(v) => {
                    const p = [...n.layout!.padding] as [number, number, number, number];
                    p[2] = v;
                    p[3] = v;
                    engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, padding: p } });
                  }}
                  onShorthand={(p) =>
                    engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, padding: p } })
                  }
                />
              </div>
            )}
            <button
              className={`icon-btn${padOpen ? " on" : ""}`}
              title="Independent padding (top, right, bottom, left)"
              onClick={() => setPadOpen((v) => !v)}
            >
              <Icon name="independent" size={14} />
            </button>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gridColumn: "1 / -1", marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "var(--dim)" }}>Canvas stacking</span>
              <button
                className={`icon-btn${n.layout.itemReverseZIndex ? " on" : ""}`}
                style={{ fontSize: 10, padding: "2px 8px", width: "auto", height: 22 }}
                title={n.layout.itemReverseZIndex ? "First on top (earlier children overlap later ones)" : "Last on top (standard CSS/DOM order)"}
                onClick={() =>
                  engine.dispatch({
                    type: "autoLayout",
                    id: n.id,
                    layout: { ...n.layout!, itemReverseZIndex: !n.layout!.itemReverseZIndex },
                  })
                }
              >
                {n.layout.itemReverseZIndex ? "First on top" : "Last on top"}
              </button>
            </div>
          </div>
        </>
      )}
      </Section>

      {n.kind === "frame" && (
        <>
          <div className="hr" />
          <Section
            id="layoutGrid"
            title="Layout grid"
            actions={
              <button
                className="plus"
                title="Add layout grid"
                onClick={() => {
                  const current = n.layoutGrids ?? [];
                  const newGrid: LayoutGrid = {
                    id: `grid-${Date.now()}`,
                    pattern: "columns",
                    count: 12,
                    gutter: 20,
                    margin: 20,
                    alignment: "stretch",
                    color: "rgba(255, 0, 0, 0.08)",
                    visible: true,
                  };
                  engine.dispatch({
                    type: "patch",
                    id: n.id,
                    patch: { layoutGrids: [...current, newGrid] },
                  });
                }}
              >
                <Icon name="plus" size={14} />
              </button>
            }
          >
            {(n.layoutGrids ?? []).length > 0 && (
              <div className="insp-pad" style={{ display: "grid", gap: 6 }}>
                {(n.layoutGrids ?? []).map((g, gi) => (
                  <div
                    key={g.id}
                    style={{
                      background: "var(--bg-subtle)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "6px 8px",
                      display: "grid",
                      gap: 4,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <select
                        style={{ fontSize: 11, fontWeight: 500 }}
                        value={g.pattern}
                        onChange={(e) => {
                          const next = [...n.layoutGrids!];
                          next[gi] = { ...g, pattern: e.target.value as GridPattern };
                          engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                        }}
                      >
                        <option value="columns">Columns</option>
                        <option value="rows">Rows</option>
                        <option value="grid">Grid</option>
                      </select>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          className="icon-btn"
                          title={g.visible !== false ? "Hide layout grid" : "Show layout grid"}
                          onClick={() => {
                            const next = [...n.layoutGrids!];
                            next[gi] = { ...g, visible: g.visible === false ? true : false };
                            engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                          }}
                        >
                          <Icon name={g.visible !== false ? "eye" : "eye-closed"} size={rowIconSize()} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Delete layout grid"
                          onClick={() => {
                            const next = n.layoutGrids!.filter((_, j) => j !== gi);
                            engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                          }}
                        >
                          <Icon name="minus" size={rowIconSize()} />
                        </button>
                      </div>
                    </div>
                    {g.pattern === "grid" ? (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 10, color: "var(--dim)" }}>Size</span>
                        <input
                          type="number"
                          min={1}
                          value={g.sectionSize ?? 10}
                          style={{ width: 60, padding: "2px 4px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "inherit" }}
                          onChange={(e) => {
                            const sz = Math.max(1, parseInt(e.target.value, 10) || 10);
                            const next = [...n.layoutGrids!];
                            next[gi] = { ...g, sectionSize: sz };
                            engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                          }}
                        />
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                        <div style={{ display: "grid", gap: 2 }}>
                          <span style={{ fontSize: 9, color: "var(--dim)" }}>Count</span>
                          <input
                            type="number"
                            min={1}
                            value={g.count ?? (g.pattern === "columns" ? 12 : 8)}
                            style={{ width: "100%", padding: "2px 4px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "inherit" }}
                            onChange={(e) => {
                              const cnt = Math.max(1, parseInt(e.target.value, 10) || 1);
                              const next = [...n.layoutGrids!];
                              next[gi] = { ...g, count: cnt };
                              engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                            }}
                          />
                        </div>
                        <div style={{ display: "grid", gap: 2 }}>
                          <span style={{ fontSize: 9, color: "var(--dim)" }}>Gutter</span>
                          <input
                            type="number"
                            min={0}
                            value={g.gutter ?? 20}
                            style={{ width: "100%", padding: "2px 4px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "inherit" }}
                            onChange={(e) => {
                              const gut = Math.max(0, parseInt(e.target.value, 10) || 0);
                              const next = [...n.layoutGrids!];
                              next[gi] = { ...g, gutter: gut };
                              engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                            }}
                          />
                        </div>
                        <div style={{ display: "grid", gap: 2 }}>
                          <span style={{ fontSize: 9, color: "var(--dim)" }}>Margin</span>
                          <input
                            type="number"
                            min={0}
                            value={g.margin ?? 20}
                            style={{ width: "100%", padding: "2px 4px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "inherit" }}
                            onChange={(e) => {
                              const mg = Math.max(0, parseInt(e.target.value, 10) || 0);
                              const next = [...n.layoutGrids!];
                              next[gi] = { ...g, margin: mg };
                              engine.dispatch({ type: "patch", id: n.id, patch: { layoutGrids: next } });
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      <div className="hr" />
      <Section id="appearance" title="Appearance">
      <div className="insp-pad">
        <div className="grid2">
          <div className="field">
            <select
              value={n.blendMode}
              onChange={(e) =>
                engine.dispatch({ type: "patch", id: n.id, patch: { blendMode: e.target.value } })
              }
            >
              {(n.kind === "frame" || n.kind === "group"
                ? ["Pass through", ...BLENDS]
                : BLENDS
              ).map((m) => (
                <option
                  key={m}
                  value={m === "Pass through" ? "pass-through" : m.toLowerCase().replace(/\s+/g, "-")}
                >
                  {m}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="%"
            value={Math.round(n.opacity * 100)}
            onChange={(v) => num("opacity", v / 100)}
          />
        </div>
      </div>
      <div className="insp-pad" style={{ marginTop: 4, display: "grid", gap: 4 }}>
        {cornersOpen && inInstance && (
          <span className="corner-lock">Individual corners are set on the component</span>
        )}
        {cornersOpen ? (
          <div className="grid2">
            {/* Figma will not let an instance carry its own corner radii; they
                come from the component. The fields say so instead of no-op'ing. */}
            {(["TL", "TR", "BL", "BR"] as const).map((lab, i) => (
              <Field
                key={lab}
                label={lab}
                disabled={inInstance}
                value={n.cornerRadii[i]}
                onChange={(v) => {
                  const r = [...n.cornerRadii] as [number, number, number, number];
                  r[i] = v;
                  patch({ cornerRadii: r, cornerIndependent: true });
                }}
              />
            ))}
          </div>
        ) : (
          <div className="grid3">
            <Field
              icon="radius"
              aria="Corner radius"
              value={n.cornerRadii[0]}
              mixed={new Set(n.cornerRadii).size > 1 ? "Mixed" : undefined}
              onChange={(v) => patch({ cornerRadii: [v, v, v, v], cornerIndependent: false })}
            />
            <span />
            <button
              className={`icon-btn${cornersOpen ? " on" : ""}`}
              disabled={inInstance}
              title="Independent corners"
              onClick={() => {
                setCornersOpen(true);
                patch({ cornerIndependent: true });
              }}
            >
              <Icon name="independent" size={14} />
            </button>
          </div>
        )}
        {cornersOpen && (
          <button
            className="icon-btn on"
            title="Uniform corners"
            onClick={() => {
              setCornersOpen(false);
              patch({ cornerIndependent: false, cornerRadii: [n.cornerRadii[0], n.cornerRadii[0], n.cornerRadii[0], n.cornerRadii[0]] });
            }}
          >
            <Icon name="independent" size={14} />
          </button>
        )}
        {/* Figma puts smoothing in the corner details panel: one value for the
            whole shape, a slider, and an iOS preset at 60%. */}
        <div className="smooth-row">
          <input
            type="range"
            className="smooth-slider"
            aria-label="Corner smoothing"
            min={0}
            max={100}
            step={1}
            value={Math.round((n.cornerSmoothing ?? 0) * 100)}
            onChange={(e) => patch({ cornerSmoothing: Number(e.target.value) / 100 })}
          />
          <Field
            label="%"
            aria="Corner smoothing percent"
            value={Math.round((n.cornerSmoothing ?? 0) * 100)}
            onChange={(v) => patch({ cornerSmoothing: Math.max(0, Math.min(100, v)) / 100 })}
          />
          <button
            className="mini"
            title="iOS corner smoothing (60%)"
            onClick={() => patch({ cornerSmoothing: 0.6 })}
          >
            iOS
          </button>
        </div>
      </div>
      {n.kind === "frame" && (
        <label className="check">
          <input
            type="checkbox"
            checked={n.showName !== false}
            onChange={(e) => patch({ showName: e.target.checked })}
          />
          Show name
        </label>
      )}
      </Section>

      <div className="hr" />
      <Section id="fill" title="Fill" actions={
        <button
          className="plus"
          title="Add fill"
          onClick={() => {
            openSection("fill");
            // First press turns the base fill back on; after that each press
            // stacks another fill on top, the way Figma's Fill "+" behaves.
            if (isNone(n.fill) && !n.fillVisible) {
              engine.dispatch({
                type: "patch",
                id: n.id,
                patch: { fill: "#d9d9d9", fillVisible: true, fillOpacity: n.fillOpacity ?? 1 },
              });
              return;
            }
            engine.dispatch({
              type: "patch",
              id: n.id,
              patch: {
                fills: [
                  ...(n.fills ?? []),
                  { type: "solid", color: "#ffffff", opacity: 1, visible: true },
                ],
              },
            });
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      }>
      {/* Figma lists a fill stack top-most first, and the base fill is the
          bottom of the stack, so it sits last in the list. */}
      {(n.fills ?? [])
        .map((p, i) => ({ p, i }))
        .reverse()
        .map(({ p, i }) => {
        const setPaint = (patch: Partial<typeof p>) =>
          engine.dispatch({
            type: "patch",
            id: n.id,
            patch: { fills: (n.fills ?? []).map((q, j) => (j === i ? { ...q, ...patch } : q)) },
          });
        return (
          <div
            className={`insp-pad paint-row${fillDrag === i ? " dragging" : ""}${fillOver === i ? " drop" : ""}`}
            key={i}
            onDragOver={(e) => {
              if (fillDrag === null) return;
              e.preventDefault();
              setFillOver(i);
            }}
            onDragLeave={() => setFillOver((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              if (fillDrag !== null) moveFill(fillDrag, i);
              setFillDrag(null);
              setFillOver(null);
            }}
          >
            <div className="paint-tools">
              <span
                className="grip"
                draggable
                title="Drag to reorder this fill"
                aria-label="Drag to reorder this fill"
                onDragStart={(e) => {
                  setFillDrag(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setFillDrag(null);
                  setFillOver(null);
                }}
              />
              <button className="mini" title="Bring forward" aria-label="Bring forward" onClick={() => moveFill(i, i + 1)}>
                <Icon name="chevron-up" size={caretSize()} />
              </button>
              <button className="mini" title="Send backward" aria-label="Send backward" onClick={() => moveFill(i, i - 1)}>
                <Icon name="chevron-down" size={caretSize()} />
              </button>
            </div>
            <ColorRow
              value={p.color}
              opacity={Math.round((p.opacity ?? 1) * 100)}
              visible={p.visible}
              type={p.type}
              stops={p.stops}
              gx={p.gx}
              gy={p.gy}
              hx={p.hx}
              hy={p.hy}
              blend={p.blend}
              recents={collectColors(snap.pages[snap.page].root)}
              background={fillBackground(snap.pages[snap.page].root, n)}
              largeText={isLargeText(n)}
              onChange={(color) => setPaint({ color, visible: true })}
              onOpacity={(v) => setPaint({ opacity: v / 100 })}
              onVisible={(v) => setPaint({ visible: v })}
              onRemove={() =>
                engine.dispatch({
                  type: "patch",
                  id: n.id,
                  patch: { fills: (n.fills ?? []).filter((_, j) => j !== i) },
                })
              }
              onMeta={(meta) =>
                setPaint({
                  gx: meta.fillGX,
                  gy: meta.fillGY,
                  hx: meta.fillHX,
                  hy: meta.fillHY,
                  blend: meta.fillBlend,
                })
              }
              onValueChange={(v) => {
                const patch = fillValuePatch(v);
                setPaint({
                  type: patch.fillType,
                  color: patch.fill,
                  stops: patch.gradientStops,
                });
              }}
            />
          </div>
        );
      })}
      {(!isNone(n.fill) || n.fillVisible) && (
        <div className="insp-pad">
          <ColorRow
            value={n.fill}
            opacity={Math.round((n.fillOpacity ?? 1) * 100)}
            visible={n.fillVisible}
            type={n.fillType}
            second={n.fillB}
            blend={n.fillBlend}
            image={n.imageSrc || undefined}
            imageFit={n.imageFit}
            imageRot={n.imageRot}
            imageExposure={n.imageExposure}
            imageContrast={n.imageContrast}
            imageSaturation={n.imageSaturation}
            imageTemperature={n.imageTemperature}
            imageTint={n.imageTint}
            imageHighlights={n.imageHighlights}
            imageShadows={n.imageShadows}
            gx={n.fillGX}
            gy={n.fillGY}
            hx={n.fillHX}
            hy={n.fillHY}
            stops={n.gradientStops}
            recents={collectColors(snap.pages[snap.page].root)}
            background={fillBackground(snap.pages[snap.page].root, n)}
            largeText={isLargeText(n)}
            onChange={(fill) => engine.dispatch({ type: "patch", id: n.id, patch: { fill, fillVisible: true } })}
            onOpacity={(v) =>
              engine.dispatch({ type: "patch", id: n.id, patch: { fillOpacity: v / 100 } })
            }
            onVisible={(v) => engine.dispatch({ type: "patch", id: n.id, patch: { fillVisible: v } })}
            onRemove={() =>
              engine.dispatch({
                type: "patch",
                id: n.id,
                patch: { fill: "#00000000", fillVisible: false },
              })
            }
            onMeta={(p) => engine.dispatch({ type: "patch", id: n.id, patch: p })}
            onValueChange={(v) => engine.dispatch({ type: "patch", id: n.id, patch: fillValuePatch(v) })}
          />
        </div>
      )}
      </Section>

      <Section id="stroke" title="Stroke" actions={
        <button
          className="plus"
          title="Add stroke"
          onClick={() => addStroke()}
        >
          <Icon name="plus" size={14} />
        </button>
      }>
      {!(n.strokeWidth > 0) && (
        <div className="insp-pad">
          <div className="empty-add">
            <span className="muted">No stroke</span>
            <button className="empty-add-btn" onClick={addStroke}>
              <Icon name="plus" size={12} /> Add stroke
            </button>
          </div>
        </div>
      )}
      {n.strokeWidth > 0 && (!isNone(n.strokePaint) || n.strokeVisible) && (
        <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
          <ColorRow
            title="Stroke"
            value={n.strokePaint}
            opacity={Math.round((n.strokeOpacity ?? 1) * 100)}
            visible={n.strokeVisible}
            recents={collectColors(snap.pages[snap.page].root)}
            background={fillBackground(snap.pages[snap.page].root, n)}
            largeText={isLargeText(n)}
            onChange={(strokePaint) =>
              engine.dispatch({ type: "patch", id: n.id, patch: { strokePaint, strokeVisible: true } })
            }
            onOpacity={(v) =>
              engine.dispatch({ type: "patch", id: n.id, patch: { strokeOpacity: v / 100 } })
            }
            onVisible={(v) => engine.dispatch({ type: "patch", id: n.id, patch: { strokeVisible: v } })}
            onRemove={() =>
              engine.dispatch({
                type: "patch",
                id: n.id,
                patch: { strokePaint: "#00000000", strokeVisible: false, strokeWidth: 0 },
              })
            }
          />
          <div className="stroke-width">
            <Field
              label="W"
              aria="Stroke weight"
              value={n.strokeWidth}
              onChange={(strokeWidth) => {
                // In Custom mode the four fields carry the weight, so typing a
                // new one sets all four, as Figma does.
                if ((n.strokeSides ?? "all") === "custom") patch({ strokeWidth, strokeSideW: [strokeWidth, strokeWidth, strokeWidth, strokeWidth] });
                else patch({ strokeWidth });
              }}
            />
            <div className="seg icons">
              {(["inside", "center", "outside"] as StrokeAlign[]).map((a) => (
                <button
                  key={a}
                  className={n.strokeAlign === a ? "on" : ""}
                  title={a}
                  onClick={() => engine.dispatch({ type: "patch", id: n.id, patch: { strokeAlign: a } })}
                >
                  <Icon name={`stroke-${a}`} size={14} />
                </button>
              ))}
            </div>
          </div>
          {sidesSupported(n.kind) && (
            <div className="stroke-sides">
              <div className="seg sides">
                {SIDES.map((side) => (
                  <button
                    key={side.id}
                    className={(n.strokeSides ?? "all") === side.id ? "on" : ""}
                    title={side.label}
                    aria-label={side.label}
                    aria-pressed={(n.strokeSides ?? "all") === side.id}
                    onClick={() => {
                      if (side.id === "custom") {
                        // Figma seeds the four fields with the current weight.
                        const w = n.strokeWidth;
                        patch({ strokeSides: "custom", strokeSideW: [w, w, w, w] });
                      } else {
                        patch({ strokeSides: side.id });
                      }
                    }}
                  >
                    {side.id === "all" ? "All" : side.id === "custom" ? "Custom" : side.id[0].toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(n.strokeSides ?? "all") === "custom" && (
            <div className="grid4">
              {(["T", "R", "B", "L"] as const).map((lab, i) => (
                <Field
                  key={lab}
                  label={lab}
                  value={sideWidths("custom", n.strokeSideW, n.strokeWidth)[i]}
                  onChange={(v) => {
                    const w = [...(n.strokeSideW ?? [n.strokeWidth, n.strokeWidth, n.strokeWidth, n.strokeWidth])] as [
                      number,
                      number,
                      number,
                      number,
                    ];
                    w[i] = v;
                    patch({ strokeSideW: w });
                  }}
                />
              ))}
            </div>
          )}
          <div className="stroke-ends">
          <div className="seg icons caps">
            {(["none", "round", "square", "arrow", "triangle", "reverse-triangle", "diamond"] as StrokeCap[]).map((c) => (
              <button
                key={c}
                className={n.strokeCap === c ? "on" : ""}
                title={
                  c === "none"
                    ? "Cap butt"
                    : c === "arrow"
                      ? "Line arrow"
                      : c === "triangle"
                        ? "Triangle arrow"
                        : c === "reverse-triangle"
                          ? "Reverse triangle"
                          : c === "diamond"
                            ? "Diamond tip"
                            : `Cap ${c}`
                }
                onClick={() => patch({ strokeCap: c })}
              >
                <Icon name={c === "arrow" ? "arrow" : c === "triangle" ? "poly" : `cap-${c}`} size={14} />
              </button>
            ))}
          </div>
          <div className="seg icons">
            {(["miter", "bevel", "round"] as StrokeJoin[]).map((j) => (
              <button
                key={j}
                className={n.strokeJoin === j ? "on" : ""}
                title={`Join ${j}`}
                onClick={() => patch({ strokeJoin: j })}
              >
                <Icon name={`join-${j}`} size={14} />
              </button>
            ))}
          </div>
          <button
            className={`icon-btn${strokeMore ? " on" : ""}`}
            title="Advanced stroke settings"
            aria-label="Advanced stroke settings"
            aria-expanded={strokeMore}
            onClick={() => setStrokeMore((v) => !v)}
          >
            <Icon name="dash" size={14} />
          </button>
          </div>
          {strokeMore && (
            <div className="adv-stroke">
              <div className="grid2">
                <Field label="–" value={n.strokeDash} onChange={(strokeDash) => patch({ strokeDash })} />
                <Field
                  label="gap"
                  value={n.strokeGap || n.strokeDash}
                  onChange={(strokeGap) => patch({ strokeGap })}
                />
              </div>
              <DashPatternField
                value={n.strokeDashPattern ?? []}
                onCommit={(pattern) => patch({ strokeDashPattern: pattern })}
              />
              <div className="seg caps small">
                {(["butt", "round", "square"] as const).map((c) => (
                  <button
                    key={c}
                    className={(n.strokeDashCap ?? "butt") === c ? "on" : ""}
                    title={`Dash cap ${c}`}
                    aria-label={`Dash cap ${c}`}
                    onClick={() => patch({ strokeDashCap: c })}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <Field
                label="miter"
                hint="Figma's miter angle: joins sharper than this bevel"
                value={n.strokeMiterAngle ?? 0}
                onChange={(v) => patch({ strokeMiterAngle: Math.max(0, Math.min(180, v)) })}
              />
            </div>
          )}
        </div>
      )}
      {(n.strokes ?? []).map((sk, i) => {
        const setStroke = (p: Partial<typeof sk>) =>
          engine.dispatch({
            type: "patch",
            id: n.id,
            patch: { strokes: (n.strokes ?? []).map((q, j) => (j === i ? { ...q, ...p } : q)) },
          });
        return (
          <div className="insp-pad" key={i} style={{ display: "grid", gap: 4 }}>
            <ColorRow
              title="Stroke"
              value={sk.color}
              opacity={Math.round((sk.opacity ?? 1) * 100)}
              visible={sk.visible}
              recents={collectColors(snap.pages[snap.page].root)}
              onChange={(color) => setStroke({ color, visible: true })}
              onOpacity={(v) => setStroke({ opacity: v / 100 })}
              onVisible={(v) => setStroke({ visible: v })}
              onRemove={() =>
                engine.dispatch({
                  type: "patch",
                  id: n.id,
                  patch: { strokes: (n.strokes ?? []).filter((_, j) => j !== i) },
                })
              }
            />
            <div className="grid2">
              <Field
                label="W"
                aria={`Stroke ${i + 2} width`}
                value={sk.width}
                onChange={(width) => setStroke({ width: Math.max(0, width) })}
              />
              <div className="seg icons">
                {(["inside", "center", "outside"] as StrokeAlign[]).map((a) => (
                  <button
                    key={a}
                    className={sk.align === a ? "on" : ""}
                    title={a}
                    onClick={() => setStroke({ align: a })}
                  >
                    <Icon name={`stroke-${a}`} size={14} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      </Section>

      {(n.kind === "star" || n.kind === "poly") && (
        <>
          <div className="hr" />
          <div className="h-row">
            <h3>{n.kind === "star" ? "Star" : "Polygon"}</h3>
          </div>
          <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
            <Field
              label="#"
              value={n.count || (n.kind === "star" ? 5 : 3)}
              onChange={(count) => patch({ count: Math.max(3, Math.min(60, Math.round(count))) })}
            />
            {n.kind === "star" && (
              <Field
                label="%"
                value={Math.round((n.starRatio || 0.4) * 100)}
                onChange={(v) => patch({ starRatio: Math.max(0.05, Math.min(0.95, v / 100)) })}
              />
            )}
            <Field
              label="r"
              value={n.cornerRadii[0] || 0}
              onChange={(r) => patch({ cornerRadii: [Math.max(0, r), Math.max(0, r), Math.max(0, r), Math.max(0, r)] })}
            />
          </div>
        </>
      )}

      {n.kind === "ellipse" && (
        <>
          <div className="hr" />
          <div className="insp-pad" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            <Field
              label="Sweep"
              hint="°"
              value={Math.round(((n.arcData?.endingAngle ?? Math.PI * 2) * 180) / Math.PI)}
              onChange={(deg) => {
                const rad = Math.max(0, Math.min(360, deg)) * (Math.PI / 180);
                const cur = n.arcData ?? { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 };
                patch({ arcData: { ...cur, endingAngle: rad } });
              }}
            />
            <Field
              label="Start"
              hint="°"
              value={Math.round(((n.arcData?.startingAngle ?? 0) * 180) / Math.PI)}
              onChange={(deg) => {
                const rad = Math.max(0, Math.min(360, deg)) * (Math.PI / 180);
                const cur = n.arcData ?? { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 };
                patch({ arcData: { ...cur, startingAngle: rad } });
              }}
            />
            <Field
              label="Ratio"
              hint="%"
              value={Math.round((n.arcData?.innerRadius ?? 0) * 100)}
              onChange={(pct) => {
                const ratio = Math.max(0, Math.min(99, pct)) / 100;
                const cur = n.arcData ?? { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 };
                patch({ arcData: { ...cur, innerRadius: ratio } });
              }}
            />
          </div>
        </>
      )}

      {n.kind === "text" && (
        <>
          <div className="hr" />
          <Section
            id="typography"
            title="Typography"
            actions={
              <button className="plus" title="Type settings" onClick={() => setTypeOpen((v) => !v)}>
                <Icon name="type-settings" size={14} />
              </button>
            }
          >
          <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
            <div className="field">
              <select
                value={n.fontFamily}
                onChange={(e) =>
                  patchType({ fontFamily: e.target.value })
                }
              >
                {[
                  "Inter",
                  "Roboto",
                  "SF Pro",
                  "Geist",
                  "Space Grotesk",
                  "Plus Jakarta Sans",
                  "Poppins",
                  "Outfit",
                  "Fira Code",
                  "JetBrains Mono",
                  "system-ui",
                ].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="grid2">
              <div className="field">
                <select
                  value={n.fontWeight}
                  onChange={(e) => patchType({ fontWeight: parseInt(e.target.value, 10) })}
                >
                  <option value={100}>Thin (100)</option>
                  <option value={200}>Extra Light (200)</option>
                  <option value={300}>Light (300)</option>
                  <option value={400}>Regular (400)</option>
                  <option value={500}>Medium (500)</option>
                  <option value={600}>Semi Bold (600)</option>
                  <option value={700}>Bold (700)</option>
                  <option value={800}>Extra Bold (800)</option>
                  <option value={900}>Black (900)</option>
                </select>
              </div>
              <Field label="S" value={n.fontSize} onChange={(v) => num("fontSize", v)} />
              <Field
                label={n.lineHeight ? "↑" : "Auto"}
                value={n.lineHeight || n.fontSize * 1.2}
                onLabelClick={() => num("lineHeight", 0)}
                onChange={(v) => num("lineHeight", v)}
              />
              <Field label="↔" value={n.letterSpacing} onChange={(v) => num("letterSpacing", v)} />
            </div>
            <div className="seg" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", width: "100%", margin: "2px 0" }}>
              <Tooltip label="Auto width" shortcut="">
                <button
                  className={n.sizingW === "hug" ? "on" : ""}
                  onClick={() => setSizing("hug", "hug")}
                >
                  <Icon name="text-auto-width" size={14} />
                  <span style={{ fontSize: 10, marginLeft: 4 }}>Auto W</span>
                </button>
              </Tooltip>
              <Tooltip label="Auto height" shortcut="">
                <button
                  className={n.sizingW !== "hug" && n.sizingH === "hug" ? "on" : ""}
                  onClick={() => setSizing("fixed", "hug")}
                >
                  <Icon name="text-auto-height" size={14} />
                  <span style={{ fontSize: 10, marginLeft: 4 }}>Auto H</span>
                </button>
              </Tooltip>
              <Tooltip label="Fixed size" shortcut="">
                <button
                  className={n.sizingW !== "hug" && n.sizingH !== "hug" ? "on" : ""}
                  onClick={() => setSizing("fixed", "fixed")}
                >
                  <Icon name="text-fixed" size={14} />
                  <span style={{ fontSize: 10, marginLeft: 4 }}>Fixed</span>
                </button>
              </Tooltip>
            </div>
            <div className="seg icons">
              {(["left", "center", "right", "justified"] as TextAlign[]).map((a) => (
                <button
                  key={a}
                  className={n.textAlign === a ? "on" : ""}
                  onClick={() => engine.dispatch({ type: "patch", id: n.id, patch: { textAlign: a } })}
                >
                  <Icon name={`align-text-${a}`} size={14} />
                </button>
              ))}
            </div>
            <div className="seg icons">
              {(["top", "middle", "bottom"] as TextAlignVertical[]).map((a) => (
                <button
                  key={a}
                  className={n.textAlignVertical === a ? "on" : ""}
                  onClick={() =>
                    engine.dispatch({ type: "patch", id: n.id, patch: { textAlignVertical: a } })
                  }
                >
                  <Icon name={`valign-${a}`} size={14} />
                </button>
              ))}
            </div>
          </div>
          {typeOpen && (
            <div className="type-pop">
              <h4>Type settings</h4>
              <div className="dir-row">
                <div className="seg icons">
                  <button
                    className={n.textDecoration === "underline" ? "on" : ""}
                    onClick={() =>
                      engine.dispatch({
                        type: "patch",
                        id: n.id,
                        patch: {
                          textDecoration: n.textDecoration === "underline" ? "none" : "underline",
                        },
                      })
                    }
                  >
                    <Icon name="underline" />
                  </button>
                  <button
                    className={n.textDecoration === "strikethrough" ? "on" : ""}
                    onClick={() =>
                      engine.dispatch({
                        type: "patch",
                        id: n.id,
                        patch: {
                          textDecoration:
                            n.textDecoration === "strikethrough" ? "none" : "strikethrough",
                        },
                      })
                    }
                  >
                    <Icon name="strike" />
                  </button>
                  <select
                    aria-label="Letter case"
                    value={n.textCase}
                    onChange={(e) => patchType({ textCase: e.target.value as XNode["textCase"] })}
                  >
                    <option value="none">Aa</option>
                    <option value="upper">AA</option>
                    <option value="lower">aa</option>
                    <option value="title">Title Case</option>
                    <option value="small-caps">Small caps</option>
                  </select>
                </div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={n.truncate}
                  onChange={(e) =>
                    patchType({ truncate: e.target.checked })
                  }
                />
                Truncate text
              </label>
              {n.truncate && (
                <div className="insp-pad">
                  <Field
                    label="L"
                    value={n.maxLines}
                    onChange={(v) =>
                      patchType({ maxLines: v })
                    }
                  />
                </div>
              )}
              <div className="insp-pad">
                <Field
                  label="¶"
                  value={n.paragraphSpacing}
                  onChange={(v) => num("paragraphSpacing", v)}
                  aria="Space after each paragraph"
                />
                <Field
                  label="⇥"
                  value={n.paragraphIndent}
                  onChange={(v) =>
                    patchType({ paragraphIndent: v })
                  }
                  aria="First-line indent of each paragraph"
                />
              </div>
              <div className="dir-row">
                <div className="seg icons">
                  <select
                    aria-label="Wrap style"
                    title="Wrap style - how a fixed-width paragraph breaks its lines"
                    value={n.textWrap}
                    onChange={(e) => patchType({ textWrap: e.target.value as XNode["textWrap"] })}
                  >
                    <option value="auto">Wrap: Off</option>
                    <option value="balance">Wrap: Balance</option>
                    <option value="pretty">Wrap: Pretty</option>
                  </select>
                  <select
                    aria-label="List"
                    title="List - markers hang in the gutter beside the paragraph"
                    value={n.listStyle}
                    onChange={(e) => patchType({ listStyle: e.target.value as XNode["listStyle"] })}
                  >
                    <option value="none">No list</option>
                    <option value="bulleted">Bulleted</option>
                    <option value="numbered">Numbered</option>
                  </select>
                </div>
              </div>
            </div>
          )}
          </Section>
        </>
      )}

      <div className="hr" />
      <Effects n={n} engine={engine} />
      <SelectionColors
        n={n}
        nodes={snap.selection
          .map((id) => find(snap.pages[snap.page].root, id))
          .filter((m): m is XNode => !!m)}
        engine={engine}
        snap={snap}
      />
      <ExportBlock n={n} engine={engine} />
    </>
  );
}

/**
 * Sketch's "Selection colors", widened to every selection instead of only
 * multi-select, and walking the whole subtree so a frame reports the colours
 * inside it. Two click targets per row, one per app: the swatch opens the
 * picker and recolors every layer sharing that colour (Sketch's
 * click-to-update-all, one undo step), the hex selects them (Figma's "Select
 * all with same fill").
 */
function SelectionColors({
  n,
  nodes,
  engine,
  snap,
}: {
  n: XNode;
  nodes: XNode[];
  engine: Engine;
  snap: Snapshot;
}) {
  // The selected layers, not the page: a row is a claim about the selection.
  const usage = colorUsageAll(nodes.length ? nodes : [n]);
  const [picking, setPicking] = useState<{ key: string; rect: DOMRect } | null>(null);
  // Sketch shows the section for any selection, single colour included — the
  // count and the select-all affordance are the point, not the list length.
  if (!usage.length) return null;
  const root = snap.pages[snap.page].root;
  return (
    <>
      <Section id="scolors" title={`Selection colors · ${usage.length}`} defaultOpen={false}>
        <div className="insp-pad scolors">
          {usage.map((u) => {
            const key = `${u.bucket}:${u.hex}`;
            return (
              <div className="scolor-row" key={key}>
                <button
                  className="scolor-sw"
                  style={{ background: u.hex }}
                  title={`Change every ${u.bucket.toLowerCase()} ${u.hex.toUpperCase()} on this page`}
                  aria-label={`Change ${u.hex}`}
                  onClick={(e) =>
                    setPicking({ key, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })
                  }
                />
                <button
                  className="scolor-hex"
                  onClick={(e) => selectByColor(engine, snap, u, e.shiftKey || e.altKey)}
                  title="Select all layers with this colour · ⇧ adds to the selection"
                >
                  {u.hex.replace("#", "").toUpperCase()}
                  <span className="scolor-kind">{u.bucket}</span>
                </button>
                <input
                  className="scolor-op"
                  aria-label={`Opacity of all ${u.hex.toUpperCase()} ${u.bucket.toLowerCase()}`}
                  title={`Opacity of the selected layers using ${u.hex.toUpperCase()} · 0-100`}
                  defaultValue={u.opacity == null ? "" : String(Math.round(u.opacity * 100))}
                  placeholder="Mixed"
                  onFocus={(e) => e.target.select()}
                  // An uncontrolled field only knows what you typed, not what
                  // landed, so mark the edit and let Escape drop it untouched -
                  // blurring a field you never changed must not cost an undo step.
                  onInput={(e) => e.currentTarget.dataset.edited = "1"}
                  onBlur={(e) => {
                    const el = e.currentTarget;
                    if (el.dataset.edited !== "1") return;
                    delete el.dataset.edited;
                    const raw = parseFloat(el.value);
                    if (Number.isNaN(raw)) {
                      el.value = u.opacity == null ? "" : String(Math.round(u.opacity * 100));
                      return;
                    }
                    const v = Math.max(0, Math.min(100, raw));
                    // Snap the field back to what was applied, so a typo never
                    // leaves the row reading a value the document does not have.
                    if (String(v) !== el.value) el.value = String(v);
                    setOpacityMatches(engine, root, u, v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      const el = e.target as HTMLInputElement;
                      delete el.dataset.edited;
                      el.value = u.opacity == null ? "" : String(Math.round(u.opacity * 100));
                      el.blur();
                    }
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <span className="scolor-pct">%</span>
                <span className="scolor-count" title={`${u.count} layers`}>
                  {u.count}
                </span>
                <button
                  className="mini"
                  title="Copy hex"
                  onClick={() => {
                    copyText(u.hex.toUpperCase());
                    toast(`Copied ${u.hex.toUpperCase()}`);
                  }}
                >
                  <Icon name="copy" size={12} />
                </button>
                {picking?.key === key && (
                  <FillPicker
                    title={`${u.bucket} colours`}
                    anchor={picking.rect}
                    recents={collectColors(root)}
                    value={{ color: u.hex, opacity: 100, type: "solid", second: "#ffffff", blend: "normal" }}
                    onChange={(v) => {
                      recolorMatches(engine, root, u, v.color);
                      setPicking(null);
                    }}
                    onClose={() => setPicking(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Section>
      <div className="hr" />
    </>
  );
}

/**
 * One effect's controls, shown in a popover anchored to its row.
 *
 * Inline these cost ~148px each — three shadows pushed the inspector 314px past
 * its viewport (measured). Figma keeps the list scannable and puts the detail
 * behind a click, which is what this does: the row stays one line, the editing
 * surface opens next to it.
 */
function EffectPopover({
  fx,
  anchor,
  layer,
  onChange,
  onClose,
}: {
  fx: Effect;
  anchor: DOMRect;
  /** The layer the effect sits on: whether it can show a shadow through itself
   *  depends on the layer's own fills and strokes. */
  layer: XNode;
  onChange: (p: Partial<Effect>) => void;
  onClose: () => void;
}) {
  const [blendOpen, setBlendOpen] = useState(false);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // The colour picker portals outside this popover, so a click inside it
      // must not count as "outside" and close the editor underneath.
      if (!t.closest(".fx-pop") && !t.closest(".fx-row") && !t.closest(".fill-pop")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", click);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", click);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const shadow = fx.kind === "drop-shadow" || fx.kind === "inner-shadow";
  const blur = fx.kind === "layer-blur" || fx.kind === "background-blur";
  // Keep the panel on screen when the row sits near the bottom of the window.
  const top = Math.min(anchor.top, window.innerHeight - 250);
  return (
    <div
      className="fill-pop fx-pop"
      style={{ left: Math.max(8, anchor.left - 252), top: Math.max(8, top) }}
      role="dialog"
      aria-label={`${EFFECT_LABEL[fx.kind]} settings`}
    >
      {shadow && (
        <ColorRow
          title="Shadow"
          value={fx.color}
          opacity={Math.round(parseHex(fx.color).a * 100)}
          visible
          recents={["#000000", "#00000040", "#ffffff"]}
          onChange={(color) => onChange({ color: withAlpha(color, parseHex(fx.color).a) })}
          onOpacity={(v) => onChange({ color: withAlpha(fx.color, v / 100) })}
        />
      )}
      {shadow && (
        <div className="grid2">
          <Field label="X" aria="Shadow X" value={fx.x} onChange={(x) => onChange({ x })} />
          <Field label="Y" aria="Shadow Y" value={fx.y} onChange={(y) => onChange({ y })} />
        </div>
      )}
      <div className="grid2">
        {(shadow || blur || fx.kind === "noise") && (
          <Field label="Blur" aria="Blur" value={fx.blur} onChange={(v) => onChange({ blur: v })} />
        )}
        {shadow && (
          <Field label="Spread" aria="Spread" value={fx.spread} onChange={(v) => onChange({ spread: v })} />
        )}
      </div>
      {fx.kind === "glass" && (
        <ColorRow
          title="Tint"
          value={fx.color}
          opacity={Math.round(parseHex(fx.color).a * 100)}
          visible
          recents={["#ffffff", "#000000"]}
          onChange={(color) => onChange({ color: withAlpha(color, parseHex(fx.color).a) })}
          onOpacity={(v) => onChange({ color: withAlpha(fx.color, v / 100) })}
        />
      )}
      {fx.kind === "texture" && (
        <div className="grid2">
          <Field label="Density" aria="Texture density" value={fx.blur} onChange={(v) => onChange({ blur: v })} />
          <Field label="Scale" aria="Texture scale" value={fx.spread} onChange={(v) => onChange({ spread: v })} />
        </div>
      )}
      {effectCanBlend(fx.kind) && (
        <>
          <button className="blend-row" onClick={() => setBlendOpen((v) => !v)}>
            Apply blend mode
            <span>
              {fx.blend ?? "Normal"}
              <Icon name="chevron" size={caretSize()} />
            </span>
          </button>
          {blendOpen && (
            <div className="type-menu blend-menu">
              {BLENDS.map((b) => (
                <button
                  key={b}
                  className={(fx.blend ?? "Normal") === b ? "on" : ""}
                  onClick={() => {
                    onChange({ blend: b });
                    setBlendOpen(false);
                  }}
                >
                  {b}
                  {(fx.blend ?? "Normal") === b && <span className="sc">✓</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {effectCanShowBehind(fx.kind) && (
        <label
          className={`fx-check${canShowBehindTransparent(layer) ? "" : " off"}`}
          title={
            canShowBehindTransparent(layer)
              ? "Show this shadow through the layer's transparent areas"
              : "Needs a translucent fill, a stroke with no fill, a blended fill or stroke, or a centre or outside stroke under 100% opacity"
          }
        >
          <input
            type="checkbox"
            checked={!!fx.showBehind}
            disabled={!canShowBehindTransparent(layer)}
            onChange={(e) => onChange({ showBehind: e.target.checked })}
          />
          Show behind transparent areas
        </label>
      )}
    </div>
  );
}

const EFFECT_LABEL: Record<string, string> = {
  "drop-shadow": "Drop shadow",
  "inner-shadow": "Inner shadow",
  "layer-blur": "Layer blur",
  "background-blur": "Background blur",
  noise: "Noise",
  glass: "Glass",
  texture: "Texture",
};

function Effects({ n, engine }: { n: XNode; engine: Engine }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ i: number; rect: DOMRect } | null>(null);
  const kinds: { id: EffectKind; label: string }[] = [
    { id: "drop-shadow", label: "Drop shadow" },
    { id: "inner-shadow", label: "Inner shadow" },
    { id: "layer-blur", label: "Layer blur" },
    { id: "background-blur", label: "Background blur" },
    { id: "noise", label: "Noise" },
    { id: "glass", label: "Glass" },
    { id: "texture", label: "Texture" },
  ];
  const effects = n.effects ?? [];
  // One layer takes eight drop shadows, eight inner shadows, one blur of each
  // kind, two noise rows and a single glass or texture - Figma's budget, and
  // the menu says so instead of silently piling on more.
  const room = (kind: EffectKind) => canAddEffect(effects, kind);
  const addKind = (kind: EffectKind) => {
    openSection("effects");
    if (!room(kind)) {
      toast(limitMessage(kind, EFFECT_LIMITS[kind] ?? 1));
      setOpen(false);
      return;
    }
    engine.dispatch({ type: "patch", id: n.id, patch: { effects: [...effects, defaultEffect(kind)] } });
    setOpen(false);
  };
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const reorder = (from: number, to: number) => {
    const next = moveEffect(effects, from, to);
    if (next.length !== effects.length || next.every((e, i) => e === effects[i])) return;
    engine.dispatch({ type: "patch", id: n.id, patch: { effects: next } });
  };
  const set = (i: number, p: Partial<Effect>) => {
    const next = effects.map((e2, j) => (j === i ? { ...e2, ...p } : e2));
    engine.dispatch({ type: "patch", id: n.id, patch: { effects: next } });
  };
  // A removed row must not leave its popover open over the wrong effect.
  const remove = (i: number) => {
    setEditing(null);
    engine.dispatch({ type: "patch", id: n.id, patch: { effects: effects.filter((_, j) => j !== i) } });
  };
  return (
    <>
      <Section
        id="effects"
        title="Effects"
        defaultOpen={effects.length > 0}
        actions={
          <div style={{ position: "relative", display: "flex" }}>
            <button
              className="plus"
              title="Add effect"
              onClick={() => {
                if (!effects.length) openSection("effects");
                setOpen((v) => !v);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            {open && (
              <div className="type-menu" style={{ right: 8, top: 28, left: "auto", width: 180 }}>
                {kinds.map((k) => (
                  <button
                    key={k.id}
                    disabled={!room(k.id)}
                    title={room(k.id) ? undefined : limitMessage(k.id, EFFECT_LIMITS[k.id] ?? 1)}
                    onClick={() => addKind(k.id)}
                  >
                    {k.label}
                    <span className="fx-count">
                      {countKind(effects, k.id)}/{EFFECT_LIMITS[k.id] ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      >
        {!effects.length && (
          <div className="insp-pad">
            <div className="empty-add">
              <span className="muted">No effects</span>
              <div className="empty-add-menu">
                {kinds.map((k) => (
                  <button key={k.id} onClick={() => addKind(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {effects.map((fx, i) => (
          <div className="insp-pad" key={i} style={{ marginBottom: 4 }}>
            <div
              className={`color-row fx-row${over === i && drag !== null && drag !== i ? " drop" : ""}`}
              onDragOver={(e) => {
                if (drag === null) return;
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver((v) => (v === i ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                if (drag !== null) reorder(drag, i);
                setDrag(null);
                setOver(null);
              }}
            >
              <span
                className="grip"
                draggable
                title="Drag to reorder this effect"
                aria-label="Drag to reorder this effect"
                onDragStart={(e) => {
                  setDrag(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
              />
              {(fx.kind === "drop-shadow" || fx.kind === "inner-shadow" || fx.kind === "glass") && (
                <span className="swatch" style={{ background: fx.color }} />
              )}
              <button
                className="hex"
                style={{
                  flex: 1,
                  textAlign: "left",
                  background: "none",
                  border: 0,
                  padding: 0,
                  cursor: "pointer",
                  color: "inherit",
                }}
                title={`${EFFECT_LABEL[fx.kind]} settings`}
                aria-label={`Edit ${EFFECT_LABEL[fx.kind]}`}
                aria-expanded={editing?.i === i}
                onClick={(e) => {
                  // Read the rect before the state updater runs: inside the
                  // updater `e.currentTarget` is already null, which threw
                  // "getBoundingClientRect of null" and left the popover shut.
                  const rect = e.currentTarget.getBoundingClientRect();
                  setEditing((cur) => (cur?.i === i ? null : { i, rect }));
                }}
              >
                {EFFECT_LABEL[fx.kind]}
              </button>
              <button
                className="mini"
                title={fx.visible ? "Hide" : "Show"}
                aria-label={`${fx.visible ? "Hide" : "Show"} ${EFFECT_LABEL[fx.kind]}`}
                onClick={() => set(i, { visible: !fx.visible })}
              >
                <Icon name={fx.visible ? "eye" : "eye-off"} size={14} />
              </button>
              <button
                className="mini minus"
                title="Remove"
                aria-label={`Remove ${EFFECT_LABEL[fx.kind]}`}
                onClick={() => remove(i)}
              >
                <Icon name="minus" size={14} />
              </button>
            </div>
          </div>
        ))}
      </Section>
      {editing && effects[editing.i] && (
        <EffectPopover
          fx={effects[editing.i]}
          anchor={editing.rect}
          layer={n}
          onChange={(p) => set(editing.i, p)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/**
 * The grid flow's own panel: the picker, the automatic-positioning switch and
 * the two track lists.
 *
 * Figma's article: "you can choose the desired number of rows and columns by
 * clicking on the grid picker in the right sidebar. Enter a value in the Number
 * of columns and Number of rows fields, or use the interactive selector." The
 * picker here is that selector - a small grid of squares, click one to set the
 * counts - with the two fields beside it, and rows reads `Auto` when they follow
 * their contents.
 */
/** What the Number of rows field's `Auto` stands for: not a count but a rule,
 *  the one Figma calls Auto - rows appear as the objects need them. */
const AUTO_ROWS = 0;

/**
 * The word a track field was given, if it was given one.
 *
 * "Tip: Typing `Auto` or `A` for a track will automatically set it to fill
 * container at one fractional unit (1fr)." `Hug` is the other mode that has no
 * size to type, so both words are read here; anything else is a number.
 */
function trackWord(raw: string): Partial<GridTrack> | null {
  const word = raw.trim().toLowerCase();
  if (word === "auto" || word === "a" || word === "fill") return { mode: "fill", fr: 1 };
  if (word === "hug" || word === "h") return { mode: "hug" };
  return null;
}

function GridPanel({
  node,
  layout,
  onChange,
}: {
  node: XNode;
  layout: AutoLayout;
  onChange: (patch: Partial<AutoLayout>) => void;
}) {
  const cols = Math.max(1, Math.floor(layout.columns ?? 2));
  const rowsAuto = layout.rows === "auto" || layout.rows == null;
  const declaredRows = rowsAuto ? 0 : Math.max(1, Math.floor(layout.rows as number));
  const [pick, setPick] = useState<{ c: number; r: number } | null>(null);
  // The plan is the engine's own, so the sidebar and the canvas agree. It also
  // gives the track list the sizes the frame really has: a track switched to
  // Fixed before a size is typed reads as what it is currently hugging, instead
  // of a zero that the frame is not actually using.
  const { used, plan } = useMemo(() => {
    const cells = [...(node.children ?? [])].filter((c) => c.visible && !c.absolutePosition);
    // The track list shows what the frame actually has, so the rows it counts
    // are the ones the objects need when the count is Auto.
    const need = cells.reduce((max, c) => Math.max(max, (c.gridRow ?? 0) + (c.rowSpan ?? 1)), 0);
    return {
      used: { rows: Math.max(need, declaredRows, 1), cols },
      plan: planGrid(node, cells, layout, hugsMain(layout, node, cells), hugsCross(layout, node, cells)),
    };
  }, [node, layout, declaredRows, cols]);
  const trackRow = (axis: "col" | "row", i: number) => {
    const list = (axis === "col" ? layout.colTracks : layout.rowTracks) ?? [];
    const t = list[i] ?? { mode: "fill" as const };
    const set = (patch: Partial<GridTrack>) => {
      const next = [...list];
      // A track that has never been touched is Auto, so the filler for the
      // tracks before this one has to be Auto too - filling with Hug would
      // silently change the tracks the user never touched.
      while (next.length < i) next.push({ mode: "fill" });
      next[i] = { ...t, ...patch };
      onChange(axis === "col" ? { colTracks: next } : { rowTracks: next });
    };
    return (
      <div className="track-row" key={`${axis}${i}`}>
        <span className="track-name">
          {axis === "col" ? "Column" : "Row"} {i + 1}
        </span>
        <button
          className="track-mode"
          title="Auto shares the free space out by fractional unit, Hug wraps the objects in the track, Fixed holds a size"
          onClick={() => set({ mode: t.mode === "fill" ? "hug" : t.mode === "hug" ? "fixed" : "fill" })}
        >
          {t.mode === "fixed" ? "Fixed" : t.mode === "hug" ? "Hug" : (t.fr ?? 1) === 1 ? "Auto" : `${t.fr}fr`}
        </button>
        {t.mode === "fixed" ? (
          <input
            className="track-size"
            aria-label={`${axis === "col" ? "Column" : "Row"} ${i + 1} size`}
            defaultValue={String(Math.round(t.size ?? (axis === "col" ? plan.colW[i] : plan.rowH[i]) ?? 0))}
            onBlur={(e) => {
              const word = trackWord(e.target.value);
              if (word) return set(word);
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) set({ size: Math.max(1, Math.round(v)) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        ) : t.mode === "fill" ? (
          <input
            className="track-size"
            aria-label={`${axis === "col" ? "Column" : "Row"} ${i + 1} fraction`}
            defaultValue={String(t.fr ?? 1)}
            onBlur={(e) => {
              const word = trackWord(e.target.value);
              if (word) return set(word);
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) set({ fr: v });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <span className="track-hint" />
        )}
        {!rowsAuto || axis === "col" ? (
          <button
            className="track-del"
            title={`Delete this ${axis === "col" ? "column" : "row"}`}
            aria-label={`Delete ${axis === "col" ? "column" : "row"} ${i + 1}`}
            onClick={() => {
              const next = [...list];
              while (next.length < i) next.push({ mode: "fill" });
              next.splice(i, 1);
              if (axis === "col") onChange({ colTracks: next, columns: Math.max(1, cols - 1) });
              // Rows on Auto keep following their objects: deleting a track
              // takes the row out and the objects below it move up. A count
              // that was typed is lowered with it.
              else
                onChange({
                  rowTracks: next,
                  ...(rowsAuto ? {} : { rows: Math.max(1, declaredRows - 1) }),
                });
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        ) : null}
      </div>
    );
  };
  return (
    <div className="grid-panel">
      <div className="grid-pick-row">
        <div
          className="grid-pick"
          role="group"
          aria-label="Grid"
          onMouseLeave={() => setPick(null)}
        >
          {Array.from({ length: 6 * 6 }, (_, i) => {
            const c = (i % 6) + 1;
            const r = Math.floor(i / 6) + 1;
            const on = pick ? c <= pick.c && r <= pick.r : c <= used.cols && r <= used.rows;
            return (
              <button
                key={i}
                className={on ? "on" : ""}
                aria-label={`${c} columns by ${r} rows`}
                onMouseEnter={() => setPick({ c, r })}
                onClick={() => onChange({ columns: c, rows: r })}
              />
            );
          })}
        </div>
        <div className="grid-counts">
          <Field
            label="Cols"
            value={used.cols}
            onChange={(v) => onChange({ columns: Math.max(1, Math.round(v)) })}
          />
          <Field
            label="Rows"
            mixed={rowsAuto ? "Auto" : undefined}
            hint="Auto"
            hintNote="as many rows as the objects need"
            value={rowsAuto ? used.rows : declaredRows}
            token={{ auto: AUTO_ROWS, a: AUTO_ROWS }}
            // `Auto` (or `A`) is the article's own shorthand for a row count
            // that follows the objects; anything else is a count of rows, and
            // a count is a floor - the grid still adds rows to fit.
            onChange={(v) =>
              onChange(v === AUTO_ROWS ? { rows: "auto" } : { rows: Math.max(1, Math.round(v)) })
            }
          />
        </div>
      </div>
      <label className="check grid-auto">
        <input
          type="checkbox"
          checked={layout.autoPosition !== false}
          onChange={(e) =>
            // Turning it back on also sets the row count to Auto, per the
            // article: "Doing so will also set Number of rows to Auto."
            onChange(e.target.checked ? { autoPosition: true, rows: "auto" } : { autoPosition: false })
          }
        />
        Automatic positioning
      </label>
      <div className="track-list">
        {Array.from({ length: used.cols }, (_, i) => trackRow("col", i))}
        {Array.from({ length: used.rows }, (_, i) => trackRow("row", i))}
      </div>
    </div>
  );
}

/**
 * The alignment box.
 *
 * Figma's article: "Select the box and use arrow keys to switch between the
 * different alignment settings. Select the box and press W/A/S/D to set
 * alignment to the edge of the frame" - so the box takes focus, arrows step the
 * position along an axis, the letters jump to an edge, `B` toggles baseline
 * alignment and `X` switches the gap between a number and Auto. The cells
 * themselves come from `alignmentCells`, which drops the box to the three
 * cross-axis options once the gap is Auto, as the article describes.
 */
function Nine({
  layout,
  onChange,
}: {
  layout: AutoLayout;
  onChange: (p: Partial<AutoLayout>) => void;
}) {
  const cells = alignmentCells(layout);
  const jj = layout.justify === "between" ? "min" : layout.justify;
  const horizontal = layout.direction === "horizontal";
  const reduced = cells.length === 3;
  // A baseline position is a cross-axis setting of its own, so it gets its own
  // name rather than being folded in with the three edges.
  const crossName = (a: LayoutAlign) =>
    a === "baseline"
      ? "Baseline"
      : a === "min"
        ? horizontal
          ? "Top"
          : "Left"
        : a === "center"
          ? "Center"
          : horizontal
            ? "Bottom"
            : "Right";
  const mainName = (j: LayoutJustify) =>
    j === "min" ? "" : j === "center" ? " · centered" : j === "between" ? " · space between" : " · packed to the end";
  const titleOf = (c: AlignCell) =>
    reduced ? crossName(c.a) : `${crossName(c.a)}${mainName(c.j)}`;
  return (
    // The attribute is how the app-wide key handlers know to stand down: while
    // this box has focus the keys above are the box's, not the canvas's.
    <div
      className={`nine${reduced ? " nine-reduced" : ""}${layout.align === "baseline" ? " baseline" : ""}`}
      title="Alignment — arrows step, W/A/S/D jump to an edge, B toggles baseline, X switches the gap"
      data-align-box="1"
      tabIndex={0}
      role="group"
      aria-label="Alignment"
      onKeyDown={(e) => {
        // Modifier chords are left to the app: ⌘A, ⌘S and friends still work.
        if (e.metaKey || e.ctrlKey) return;
        const key = alignKey(e.key);
        if (!key) return;
        const patch = layoutKeyPatch(layout, key);
        if (!patch) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(patch);
      }}
    >
      {cells.map((c, i) => (
        <button
          key={i}
          title={titleOf(c)}
          className={jj === c.j && layout.align === c.a ? "on" : ""}
          aria-label={titleOf(c)}
          onClick={() => onChange({ justify: c.j, align: c.a })}
        />
      ))}
    </div>
  );
}

/**
 * Figma's custom dash syntax: one text field holding `dash, gap, dash, gap…`.
 * Anything that is not a list of non-negative numbers is refused and the field
 * snaps back to what the layer actually has, rather than clearing the dashes.
 */
function DashPatternField({
  value,
  onCommit,
}: {
  value: number[];
  onCommit: (pattern: number[]) => void;
}) {
  const text = value.length ? value.join(", ") : "";
  const [draft, setDraft] = useState(text);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setDraft(value.length ? value.join(", ") : "");
    setBad(false);
  }, [text]);
  const commit = () => {
    const parsed = parseDashPattern(draft);
    if (parsed === null) {
      setBad(true);
      setDraft(text);
      return;
    }
    setBad(false);
    if (parsed.length !== value.length || parsed.some((v, i) => v !== value[i])) onCommit(parsed);
    setDraft(parsed.length ? parsed.join(", ") : "");
  };
  return (
    <div className="field">
      <label title="Custom dash pattern · dash, gap, dash, gap…">dashes</label>
      <input
        aria-label="Dash pattern"
        value={draft}
        placeholder="10, 20, 80, 20"
        className={bad ? "bad" : ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

/**
 * A padding field.
 *
 * Figma: "To set uniform padding or to use CSS shorthand, hold ⌘ Command or
 * Control and click into any padding field... entering 1,2,3,4 sets the top,
 * right, bottom, and left to 1, 2, 3, and 4 respectively." So a plain click
 * commits one number, and a ⌘/Ctrl click turns the same field into a shorthand
 * entry - `1`, `1,2`, `1,2,3` or `1,2,3,4` - parsed by `parsePaddingShorthand`.
 * Anything that is not a list of numbers is refused and the field snaps back,
 * exactly as the other numeric fields in the panel do.
 */
function PadField({
  label,
  icon,
  aria,
  value,
  mixed,
  onCommit,
  onShorthand,
}: {
  label?: string;
  icon?: string;
  aria?: string;
  value: number;
  mixed?: string;
  onCommit: (v: number) => void;
  /** Only the H/V fields accept shorthand: with four separate fields there is
   *  no single entry to spell four sides out in. */
  onShorthand?: (p: [number, number, number, number]) => void;
}) {
  const [shorthand, setShorthand] = useState(false);
  const [draft, setDraft] = useState("");
  const shown = shorthand ? draft : mixed ?? String(Math.round(value * 100) / 100);
  const commit = (raw: string) => {
    if (shorthand && onShorthand) {
      const parsed = parsePaddingShorthand(raw);
      if (parsed) onShorthand(parsed);
      else if (!/[0-9]/.test(raw)) onCommit(value);
      setShorthand(false);
      return;
    }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) onCommit(n);
  };
  return (
    <div className={`field${shorthand ? " shorthand" : ""}`} data-pname={aria ?? label}>
      {icon ? <Icon name={icon} size={14} /> : <label title={label}>{label}</label>}
      <input
        value={shown}
        aria-label={aria ?? label}
        title={
          shorthand
            ? "CSS shorthand: 1 · 1,2 · 1,2,3 · 1,2,3,4 (top, right, bottom, left)"
            : "⌘-click to set all sides, or type 1,2,3,4"
        }
        onMouseDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && onShorthand) {
            // The click that starts the shorthand is also the click that would
            // have placed the caret: swallow it and put the caret at the end.
            setShorthand(true);
            setDraft("");
            e.preventDefault();
            (e.target as HTMLInputElement).focus();
            (e.target as HTMLInputElement).select();
          }
        }}
        onFocus={() => {
          if (shorthand) setDraft("");
        }}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          // Shorthand is only read once the entry is finished - part-way
          // through `1,2,3,4` every prefix is a different set of sides.
          if (shorthand) return;
          const n = parseFloat(next);
          if (Number.isFinite(n)) onCommit(n);
        }}
        onBlur={(e) => {
          commit(e.target.value);
          setDraft("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setShorthand(false);
            setDraft("");
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {!shorthand && mixed && <span className="hint">{mixed[0].toUpperCase()}</span>}
    </div>
  );
}

function Field({
  label,
  icon,
  value,
  onChange,
  hint,
  hintNote,
  onLabelClick,
  aria,
  mixed,
  token,
  disabled,
}: {
  label?: string;
  icon?: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  /** Why the hint is what it is, e.g. a hug that a filling child turned into a
   *  Fixed frame. Shown on the label, next to the value. */
  hintNote?: string;
  onLabelClick?: () => void;
  /** Accessible name for icon-only fields, which otherwise expose no label
   *  at all to assistive tech or to keyboard users reading focus. */
  aria?: string;
  /** Figma shows "Mixed" instead of a number when the selection - or, for
   *  corner radii, the four corners - disagrees. Typing still applies. */
  mixed?: string;
  /** Words this field also accepts, each standing for a number: a grid's
   *  Number of rows takes `Auto` (or `A`), which means "as many as the objects
   *  need" rather than a count. */
  token?: Record<string, number>;
  /** A property the layer cannot own here, e.g. a corner radius on an instance. */
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => mixed ?? fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(mixed ?? fmt(value));
  }, [value, mixed]);
  // Figma reads these fields as arithmetic, not just digits: `120/3`, `2^3`,
  // `(40+8)*2`, and `+10` to nudge against whatever is already there. Only the
  // commit evaluates, so typing `12/` mid-expression does not move the layer.
  const commit = () => {
    const word = token?.[draft.trim().toLowerCase()];
    const parsed =
      word != null
        ? word
        : mixed && !hasExpression(draft) && !/[0-9]/.test(draft)
          ? null
          : hasExpression(draft)
            ? evalField(draft, value)
            : parseFloat(draft);
    if (parsed != null && Number.isFinite(parsed)) {
      onChange(parsed);
      setDraft(fmt(parsed));
    } else {
      setDraft(mixed ?? fmt(value));
    }
  };
  return (
    <div
      className="field"
      // View > Property labels reads this: with labels on, an icon-only field
      // prints the property's own name instead of leaving the icon to be
      // decoded. The name lives in a data attribute so the sidebar does not
      // have to thread a boolean through every field in the file.
      data-pname={icon ? (aria ?? label ?? icon) : undefined}
    >
      {icon ? (
        <Icon name={icon} size={14} />
      ) : (
        <label
          title={hint ? `${label} · ${hintNote ?? hint}` : label}
          onClick={onLabelClick}
          style={onLabelClick ? { cursor: "pointer" } : undefined}
        >
          {label}
        </label>
      )}
      <input
        value={draft}
        disabled={disabled}
        aria-label={aria ?? label}
        title={(aria && !label ? aria : "") || "Number or equation · + - * / ^ ( )"}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (hasExpression(next)) return;
          const parsed = parseFloat(next);
          if (!Number.isNaN(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {hint && hint !== "fixed" && <span className="hint">{hint[0].toUpperCase()}</span>}
    </div>
  );
}

function cycleSizing(s: Sizing | undefined): Sizing {
  if (s === "fixed") return "hug";
  if (s === "hug") return "fill";
  return "fixed";
}

function Constraints({
  h,
  v,
  onChange,
}: {
  h: Constraint;
  v: Constraint;
  onChange: (axis: "h" | "v", value: Constraint) => void;
}) {
  const opts: { id: Constraint; label: string }[] = [
    { id: "min", label: "Left / Top" },
    { id: "center", label: "Center" },
    { id: "max", label: "Right / Bottom" },
    { id: "stretch", label: "Left & right / Top & bottom" },
    { id: "scale", label: "Scale" },
  ];
  return (
    <div className="cons-pop">
      <div className="cons-grid">
        <select value={h} onChange={(e) => onChange("h", e.target.value as Constraint)}>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              H: {o.label.split(" / ")[0]}
            </option>
          ))}
        </select>
        <select value={v} onChange={(e) => onChange("v", e.target.value as Constraint)}>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              V: {o.label.split(" / ")[1] ?? o.label}
            </option>
          ))}
        </select>
      </div>
      <p className="muted-inline" style={{ padding: "4px 0 0" }}>
        Pin this layer to its parent when the parent resizes.
      </p>
    </div>
  );
}

/* Formats, scales and the per-format capability table live in ./exportModel, so
   the panel and the exporter read one source. */
const SCALES = SCALE_PRESETS;

/* Every format's optional settings live behind one "Export settings" button, as
   in Figma, and the list is built from the capability table rather than written
   out per format - so a control cannot appear for something the exporter does
   not do. */
function hasSettings(format: ExportFormat): boolean {
  const c = FORMAT_CAPS[format];
  return (
    c.ignoreOverlap ||
    c.boundingBox ||
    c.includeId ||
    c.outlineText ||
    c.simplifyStroke ||
    c.quality ||
    c.resampling
  );
}

/** The settings Figma shows for whatever format the row is set to. */
function ExportSettings({
  preset,
  onChange,
}: {
  preset: ExportPreset;
  onChange: (next: ExportPreset) => void;
}) {
  const caps = FORMAT_CAPS[preset.format];
  const settings = resolveSettings(preset);
  const flip = (key: "ignoreOverlap" | "boundingBox" | "includeId" | "outlineText" | "simplifyStroke") =>
    onChange({ ...preset, [key]: !settings[key] });
  /** A caret-down menu, because a native select cannot be styled to match and
   *  writes its own option list. */
  const pick = (key: "quality" | "resampling", values: readonly string[]) => {
    const at = values.indexOf(String(settings[key]));
    onChange({ ...preset, [key]: values[(at + 1) % values.length] });
  };
  return (
    <div className="export-settings insp-pad">
      {caps.ignoreOverlap && (
        <label className="check" title="Export the selected layers only, ignoring anything overlapping them">
          <input type="checkbox" checked={settings.ignoreOverlap} onChange={() => flip("ignoreOverlap")} />
          Ignore overlapping layers
        </label>
      )}
      {caps.boundingBox && (
        <label className="check" title="Text layers only: keep the layer's bounding box, empty space and all">
          <input type="checkbox" checked={settings.boundingBox} onChange={() => flip("boundingBox")} />
          Include bounding box
        </label>
      )}
      {caps.includeId && (
        <label className="check" title="Write an id, taken from the layer's name, onto the svg element">
          <input type="checkbox" checked={settings.includeId} onChange={() => flip("includeId")} />
          Include &ldquo;id&rdquo; attribute
        </label>
      )}
      {caps.resampling && (
        <button className="set-row" onClick={() => pick("resampling", ["detailed", "basic"])}>
          Image resampling
          <span className="set-val">
            {settings.resampling === "basic" ? "Basic" : "Detailed"}
            <Icon name="chevron" size={caretSize()} />
          </span>
        </button>
      )}
      {caps.quality && (
        <button className="set-row" onClick={() => pick("quality", ["low", "medium", "high"])}>
          Image quality
          <span className="set-val">
            {settings.quality[0].toUpperCase() + settings.quality.slice(1)}
            <Icon name="chevron" size={caretSize()} />
          </span>
        </button>
      )}
      {caps.resampling && (
        <p className="hint">
          {settings.resampling === "basic"
            ? "Basic picks the nearest pixel: best for icons, logos and pixel art."
            : "Detailed averages the surrounding pixels: best for gradients, shadows and photographs."}
        </p>
      )}
    </div>
  );
}

/** Figma's scale field: type `2x`, `500w` or `300h`, or click for the presets. */
function ScaleField({
  preset,
  locked,
  onCommit,
}: {
  preset: ExportPreset;
  locked: boolean;
  onCommit: (scale: number | string) => void;
}) {
  const [draft, setDraft] = useState(() => formatScale(preset.scale));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(formatScale(preset.scale));
  }, [preset.scale]);
  if (locked) {
    return (
      <span className="fmt locked" title="SVGs and PDFs export at 1x only">
        1x
      </span>
    );
  }
  return (
    <input
      className="scale"
      aria-label="Scale"
      title="Scale: a multiplier such as 2x, or a size such as 500w or 300h"
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        // Commit as you type once the text is a complete spec, so the preview
        // follows the field rather than waiting for a blur.
        if (/^\d*\.?\d+\s*[xwh]?$/i.test(next.trim()) && /\d/.test(next)) onCommit(next.trim());
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(formatScale(preset.scale));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function ExportBlock({ n, engine }: { n: XNode; engine: Engine }) {
  const presets = n.exports ?? [];
  const [preview, setPreview] = useState<Record<number, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState<number | null>(null);
  const add = () => {
    openSection("export");
    engine.dispatch({
      type: "patch",
      id: n.id,
      patch: { exports: [...presets, newPreset("PNG")] },
    });
  };
  const set = (i: number, p: ExportPreset) => {
    const next = presets.map((e, j) => (j === i ? p : e));
    engine.dispatch({ type: "patch", id: n.id, patch: { exports: next } });
  };
  return (
    <>
      <Section
        id="export"
        title="Export"
        defaultOpen={false}
        actions={
          <>
            <button
              className="link"
              title="Export settings for the whole page (⇧⌘E)"
              onClick={() => window.dispatchEvent(new CustomEvent("x-native-export-dialog"))}
            >
              All…
            </button>
            <button
              className="plus"
              title="Add export"
              onClick={() => {
                openSection("export");
                add();
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          </>
        }
      >
        {presets.map((p, i) => (
          <div key={i} className="insp-pad" style={{ marginBottom: 4 }}>
            <div className="export-row">
              {/* Figma previews the export before you download it — the thumbnail
                  is the real render (SVG source, so it scales with the preset). */}
              <button
                className={`export-thumb${preview[i] ? " on" : ""}`}
                title={preview[i] ? "Hide preview" : "Preview"}
                aria-pressed={!!preview[i]}
                onClick={() => setPreview((v) => ({ ...v, [i]: !v[i] }))}
              >
                {preview[i] ? <img src={previewUrl(n, p)} alt="" /> : <Icon name="image" size={12} />}
              </button>
              <button
                className="fmt"
                title="Format"
                onClick={() => {
                  const format = FORMATS[(FORMATS.indexOf(p.format) + 1) % FORMATS.length];
                  // Switching format keeps the settings that still apply and
                  // drops the rest: a JPG has no "id attribute" to remember, and
                  // a 2x silently ignored on an SVG would read as a lie.
                  const keep = FORMAT_CAPS[format];
                  set(i, {
                    format,
                    suffix: p.suffix,
                    scale: keep.oneToOne ? 1 : p.scale,
                    includeId: keep.includeId ? p.includeId : undefined,
                    outlineText: keep.outlineText ? p.outlineText : undefined,
                    simplifyStroke: keep.simplifyStroke ? p.simplifyStroke : undefined,
                    ignoreOverlap: keep.ignoreOverlap ? p.ignoreOverlap : undefined,
                    boundingBox: keep.boundingBox ? p.boundingBox : undefined,
                    quality: keep.quality ? p.quality : undefined,
                    resampling: keep.resampling ? p.resampling : undefined,
                  });
                }}
              >
                {p.format}
              </button>
              {/* Figma's scale field takes a multiplier or a size with a unit:
                  `2x`, `500w`, `300h`. A vector format is pinned at 1x, because
                  "Figma only supports exports for SVGs at 1x" - and the same
                  for PDFs - so the field shows 1x rather than quietly ignoring
                  what you type. */}
              <ScaleField
                preset={p}
                locked={FORMAT_CAPS[p.format].oneToOne}
                onCommit={(scale) => set(i, { ...p, scale })}
              />
              <input
                className="suffix"
                placeholder="suffix"
                title="Appended to the file name"
                value={p.suffix}
                onChange={(e) => set(i, { ...p, suffix: e.target.value })}
              />
              <button
                className={`mini settings${settingsOpen === i ? " on" : ""}`}
                title="Export settings"
                aria-expanded={settingsOpen === i}
                disabled={!hasSettings(p.format)}
                onClick={() => setSettingsOpen((v) => (v === i ? null : i))}
              >
                <Icon name="more" size={14} />
              </button>
              <button
                className="mini minus"
                title="Remove"
                onClick={() =>
                  engine.dispatch({
                    type: "patch",
                    id: n.id,
                    patch: { exports: presets.filter((_, j) => j !== i) },
                  })
                }
              >
                <Icon name="minus" size={14} />
              </button>
            </div>
            {settingsOpen === i && <ExportSettings preset={p} onChange={(next) => set(i, next)} />}
            {preview[i] && (
              <div className="export-checker">
                <img src={previewUrl(n, p)} alt={`Preview of ${n.name}${p.suffix} at ${p.scale}×`} />
              </div>
            )}
          </div>
        ))}
        {!!presets.length && (
          <div className="insp-pad">
            <button className="export-run" onClick={() => presets.forEach((p) => runExport(n, p))}>
              Export
            </button>
          </div>
        )}
        {!presets.length && (
          <div className="insp-pad">
            <div className="empty-add">
              <span className="muted">No export settings</span>
              <button className="empty-add-btn" onClick={add}>
                <Icon name="plus" size={12} /> Add image export
              </button>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

/** A data URL of the exact SVG this preset would write, used by the preview. */
function previewUrl(n: XNode, p: ExportPreset) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg(n, p))}`;
}

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

function runExport(n: XNode, p: ExportPreset) {
  const { width, height } = exportSize(n, p);
  const settings = resolveSettings(p);
  // The suffix is appended straight onto the layer's name, with no separator:
  // the article's own example is "HomePage" + "draft" -> "HomePagedraft.png".
  const name = `${n.name}${p.suffix}.${p.format.toLowerCase()}`;
  const svg = exportSvg(n, p);
  if (p.format === "SVG") {
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), name);
    return;
  }
  const image = new Image();
  image.onload = () => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    // "Image resampling": Detailed is a weighted average of the surrounding
    // pixels (what the browser does by default, at high quality); Basic is
    // nearest neighbour, which keeps a hard edge hard - the right choice for an
    // icon or pixel art, and the wrong one for a gradient.
    if (settings.resampling === "basic") {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    // PDF keeps transparency via a soft mask, so it must not be flattened.
    if (p.format === "JPG") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(image, 0, 0, width, height);
    if (p.format === "PDF") {
      const px = ctx.getImageData(0, 0, width, height).data;
      // Page size is the design size in points; a larger bitmap raises the
      // effective resolution of the page without changing its size.
      void buildPdf(new Uint8Array(px.buffer.slice(0)), width, height, Math.max(1, n.w), Math.max(1, n.h), n.name)
        .then((blob) => downloadBlob(blob, name))
        .catch(() => toast("Could not build the PDF"));
      return;
    }
    c.toBlob(
      (blob) => blob && downloadBlob(blob, name),
      p.format === "JPG" ? "image/jpeg" : "image/png",
      qualityValue(settings.quality),
    );
  };
  image.onerror = () => toast(`Could not render ${n.name} for export`);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Copy the layer's snippet in the given language — the very renderer the panel
 *  uses, so a copied answer and a shown answer cannot disagree. Omit `format`
 *  to take the developer's current preference. */
export function copyLayerCode(n: XNode, format?: DevFormat): void {
  const prefs = getDevPrefs();
  const fmt = format ?? prefs.format;
  const code = renderDevCode(n, fmt, fmt === "css" ? prefs.unit : "px");
  copyText(code);
  toast(`Copied ${devLangLabel(fmt)} \u00b7 ${n.name}`);
}

/** Put a PNG of the layer on the clipboard. It reuses the export renderer, so
 *  what lands in Slack is what the downloaded file would have contained. */
export function copyPng(n: XNode) {
  const preset: ExportPreset = { format: "PNG", scale: 2, suffix: "" };
  const { width, height } = exportSize(n, preset);
  const image = new Image();
  image.onload = () => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) {
      toast("Could not render this layer");
      return;
    }
    ctx.drawImage(image, 0, 0, width, height);
    c.toBlob(async (blob) => {
      if (!blob) {
        toast(`Could not render ${n.name} for copying`);
        return;
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast(`Copied ${n.name} as PNG`);
      } catch {
        // A clipboard that will not take images (older Safari, denied
        // permission) still gets the user the pixels, just as a file.
        downloadBlob(blob, `${n.name}.png`);
        toast("Clipboard cannot take images · downloaded the PNG instead");
      }
    }, "image/png");
  };
  image.onerror = () => toast(`Could not render ${n.name} for copying`);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg(n, preset))}`;
}

function fillValuePatch(v: FillValue): Partial<XNode> {
  const type = v.type || "solid";
  const handles = handlesForFill(type);
  return {
    fill: v.color,
    fillOpacity: Math.max(0, Math.min(1, (v.opacity ?? 100) / 100)),
    fillVisible: true,
    fillType: type,
    fillB: v.second,
    gradientStops: v.stops ?? [],
    fillBlend: v.blend,
    imageSrc: type === "image" ? v.image || "" : "",
    imageFit: v.imageFit || "fill",
    imageRot: v.imageRot || 0,
    imageExposure: v.imageExposure || 0,
    imageContrast: v.imageContrast || 0,
    imageSaturation: v.imageSaturation || 0,
    imageTemperature: v.imageTemperature || 0,
    imageTint: v.imageTint || 0,
    imageHighlights: v.imageHighlights || 0,
    imageShadows: v.imageShadows || 0,
    ...(v.gx != null
      ? { fillGX: v.gx, fillGY: v.gy, fillHX: v.hx, fillHY: v.hy }
      : handles
        ? { fillGX: handles.fillGX, fillGY: handles.fillGY, fillHX: handles.fillHX, fillHY: handles.fillHY }
        : {}),
  };
}

/** Collapsible inspector section.
 *
 *  The panel runs past the viewport on a text layer (1043px of content in
 *  912px), so the lower sections — Effects, Export — are below the fold and
 *  easy to miss. Rather than hide controls behind an "Advanced" bucket, which
 *  makes real properties harder to find, each section can be folded away and
 *  remembers that choice. Nothing is removed, and everything stays one click
 *  from view.
 *
 *  `id` keys the persisted open/closed state; `defaultOpen` false starts a
 *  section folded for layers that rarely need it.
 */
const SECTION_KEY = "x-native-inspector-sections";

function readSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Ask a section to reveal itself. Adding a fill/stroke/export while its
 *  section is collapsed used to write state the user could not see, which read
 *  as "Export does nothing". Figma expands and scrolls to the new row. */
export function openSection(id: string) {
  window.dispatchEvent(new CustomEvent("x-native-open-section", { detail: id }));
}

function Section({
  id,
  title,
  defaultOpen = true,
  actions,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readSections()[id] ?? defaultOpen);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail !== id) return;
      setOpen(true);
      try {
        localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readSections(), [id]: true }));
      } catch {
        /* preference only */
      }
      requestAnimationFrame(() => rowRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    };
    window.addEventListener("x-native-open-section", on);
    return () => window.removeEventListener("x-native-open-section", on);
  }, [id]);
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readSections(), [id]: next }));
      } catch {
        /* preference only; not worth surfacing */
      }
      return next;
    });
  };
  return (
    <>
      <div className="h-row" ref={rowRef}>
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

function ColorRow({
  title = "Fill",
  value,
  opacity = 100,
  visible = true,
  type = "solid",
  second = "#ffffff",
  blend = "Normal",
  image,
  imageFit = "fill",
  imageRot = 0,
  imageExposure = 0,
  imageContrast = 0,
  imageSaturation = 0,
  imageTemperature = 0,
  imageTint = 0,
  imageHighlights = 0,
  imageShadows = 0,
  gx,
  gy,
  hx,
  hy,
  stops,
  recents = [],
  background,
  largeText,
  onChange,
  onOpacity,
  onVisible,
  onRemove,
  onMeta,
  onValueChange,
}: {
  title?: string;
  value: string;
  opacity?: number;
  visible?: boolean;
  type?: FillValue["type"];
  second?: string;
  blend?: string;
  image?: string;
  imageFit?: FillValue["imageFit"];
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
  stops?: FillValue["stops"];
  recents?: string[];
  /** Passed to the picker's contrast check: what this paint is actually over. */
  background?: string;
  largeText?: boolean;
  onChange: (v: string) => void;
  onOpacity?: (v: number) => void;
  onVisible?: (v: boolean) => void;
  onRemove?: () => void;
  onMeta?: (p: Partial<XNode>) => void;
  onValueChange?: (v: FillValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const isImage = type === "image" || !!image;
  const hidden = !isImage && (!visible || isNone(value));
  const hex = value.length >= 7 ? value.slice(0, 7) : "#000000";
  // The hex field keeps its own draft while typing. Committing on every
  // keystroke meant an in-progress value like "f" was parsed as an invalid
  // colour and normalised to black, which wiped the field mid-entry and made
  // the control impossible to type into. Commit only complete hex values,
  // matching how FillPicker already handles the same input.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = hidden ? "" : isImage ? "Image" : hex.replace("#", "");
  return (
    <div className="color-row">
      <button
        type="button"
        className="swatch"
        style={
          isImage && image
            ? { backgroundImage: `url(${image})`, backgroundSize: "cover", backgroundPosition: "center" }
            : { background: hidden ? "transparent" : hex }
        }
        title="Color picker"
        onClick={(e) => {
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
          setOpen(true);
        }}
      />
      <input
        className="hex"
        aria-label={title ? `${title} colour hex` : "Colour hex"}
        value={draft ?? shown}
        placeholder="None"
        spellCheck={false}
        readOnly={isImage}
        onChange={(e) => {
          if (isImage) return;
          const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
          setDraft(v);
          if (v.length === 3 || v.length === 4 || v.length === 6 || v.length === 8) {
            onChange("#" + v);
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      {onOpacity && (
        <input
          className="op"
          aria-label={title ? `${title} opacity` : "Opacity"}
          value={`${opacity}%`}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onOpacity(Math.max(0, Math.min(100, v)));
          }}
        />
      )}
      <button
        className="mini"
        title={hidden ? "Show" : "Hide"}
        onClick={() => onVisible?.(!visible)}
      >
        <Icon name={hidden ? "eye-off" : "eye"} size={14} />
      </button>
      {onRemove && (
        <button className="mini minus" title="Remove" onClick={onRemove}>
          <Icon name="minus" size={14} />
        </button>
      )}
      {open && anchor && (
        <FillPicker
          title={title}
          value={{
            color: hex,
            opacity,
            type: isImage ? "image" : type,
            second,
            blend,
            image,
            imageFit,
            imageRot,
            imageExposure,
            imageContrast,
            imageSaturation,
            imageTemperature,
            imageTint,
            imageHighlights,
            imageShadows,
            gx,
            gy,
            hx,
            hy,
            stops,
          }}
          recents={recents}
          anchor={anchor}
          background={background}
          largeText={largeText}
          onChange={(v) => {
            if (onValueChange) {
              onValueChange(v);
              return;
            }
            onChange(v.color);
            onOpacity?.(v.opacity);
            onMeta?.(fillValuePatch(v));
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * What a paint is actually drawn over, for the contrast check: the nearest
 * ancestor with a visible solid fill, falling back to the white paper the
 * canvas sits on. Figma resolves the background the same way and always treats
 * the selected layer as the foreground.
 */
function fillBackground(root: XNode, n: XNode): string {
  for (let p = findParent(root, n.id); p; p = findParent(root, p.id)) {
    if (p.kind === "text") continue;
    if (p.fillVisible !== false && !isNone(p.fill) && p.fillType === "solid") return p.fill.slice(0, 7);
    for (const q of p.fills ?? []) {
      if (q.visible !== false && q.type === "solid" && !isNone(q.color)) return q.color.slice(0, 7);
    }
  }
  return "#ffffff";
}

/** WCAG's large-text exemption, in Figma's terms: 24px, or 19px and bold. */
function isLargeText(n: XNode): boolean {
  return n.kind === "text" && (n.fontSize >= 24 || (n.fontSize >= 19 && n.fontWeight >= 700));
}

function fmt(v: number) {
  const r = Math.round(v);
  if (Math.abs(v - r) < 0.001) return String(r);
  return String(Math.round(v * 100) / 100);
}

function setDir(engine: Engine, snap: Snapshot, n: XNode, direction: "horizontal" | "vertical") {
  setFlow(engine, snap, n.id, direction);
}

/** Human labels + Figma's shortcuts for the align row. */
/** Zoom control + view options.
 *
 *  Figma keeps this in one place: the top-right of the right sidebar shows the
 *  current percentage, the field itself takes typed input, and the caret opens
 *  the zoom presets and the canvas view toggles. The previous button cycled
 *  100%→50%→100% and could never reach 200%.
 */
function ZoomMenu({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => {
    if (editing) input.current?.focus();
    if (editing) input.current?.select();
  }, [editing]);

  const go = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  const commit = () => {
    const z = parseZoomInput(draft);
    if (z != null) zoomAboutCentre(engine, z);
    setEditing(false);
  };
  const page = snap.pages[snap.page];
  const near = (z: number) => Math.abs(snap.zoom - z) < 0.005 * Math.max(1, z);

  return (
    <div className="zoom-ctl" ref={root}>
      {editing ? (
        <input
          ref={input}
          className="zoom-input"
          aria-label="Zoom percentage"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setEditing(false);
              e.stopPropagation();
            }
          }}
        />
      ) : (
        <button
          className="zoom"
          title="Zoom · type a percentage"
          onClick={() => {
            setEditing(true);
            setDraft(String(Math.round(snap.zoom * 100)));
          }}
        >
          {zoomLabel(snap.zoom)}
        </button>
      )}
      <button
        ref={btn}
        className="zoom-caret"
        title="Zoom and view options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-down" size={caretSize()} />
      </button>
      {open && (
        <div className="ctx zoom-menu" role="menu">
          <button role="menuitem" onClick={go(() => zoomTo(engine, "fit"))}>
            Zoom to fit<span className="sc">⇧1</span>
          </button>
          <button
            role="menuitem"
            disabled={!snap.selection.length}
            onClick={go(() => zoomTo(engine, "selection"))}
          >
            Zoom to selection<span className="sc">⇧2</span>
          </button>
          <button role="menuitem" onClick={go(() => zoomAboutCentre(engine, 1))}>
            Zoom to 100%<span className="sc">⇧0</span>
          </button>
          <hr />
          <div className="menu-label">Presets</div>
          <div className="zoom-grid">
            {ZOOM_STEPS.map((z) => (
              <button
                key={z}
                role="menuitemradio"
                aria-checked={near(z)}
                className={near(z) ? "on" : ""}
                onClick={go(() => zoomAboutCentre(engine, z))}
              >
                {Math.round(z * 100)}%
              </button>
            ))}
          </div>
          <div className="zoom-grid">
            <button role="menuitem" onClick={go(() => zoomAboutCentre(engine, stepZoom(snap.zoom, 1)))}>
              <Icon name="zoom-in" size={12} /> Zoom in<span className="sc">⇧=</span>
            </button>
            <button role="menuitem" onClick={go(() => zoomAboutCentre(engine, stepZoom(snap.zoom, -1)))}>
              <Icon name="zoom-out" size={12} /> Zoom out<span className="sc">⇧−</span>
            </button>
          </div>
          <hr />
          <div className="menu-label">Canvas</div>
          <button role="menuitemcheckbox" aria-checked={snap.showRulers} onClick={go(() => engine.dispatch({ type: "toggleRulers" }))}>
            Rulers<span className="sc">⇧R</span>
            {snap.showRulers && <Icon name="check" size={12} className="tick" />}
          </button>
          <button
            role="menuitemcheckbox"
            aria-checked={page.pixelGrid}
            onClick={go(() => engine.dispatch({ type: "patchPage", patch: { pixelGrid: !page.pixelGrid } }))}
          >
            Pixel grid
            {snap.zoom < 4 && <span className="hint">visible at 400%+</span>}
            <span className="sc">⌘&apos;</span>
            {page.pixelGrid && <Icon name="check" size={12} className="tick" />}
          </button>
          <button
            role="menuitemcheckbox"
            aria-checked={page.pixelSnap ?? true}
            onClick={go(() => engine.dispatch({ type: "patchPage", patch: { pixelSnap: !(page.pixelSnap ?? true) } }))}
          >
            Snap to pixel grid<span className="sc">⌘⇧&apos;</span>
            {page.pixelSnap ?? true ? <Icon name="check" size={12} className="tick" /> : null}
          </button>
          <div className="menu-label">Pixel preview</div>
          {(["off", "1x", "2x"] as const).map((pv) => (
            <button
              key={pv}
              role="menuitemradio"
              aria-checked={snap.pixelPreview === pv}
              onClick={go(() => engine.dispatch({ type: "setPixelPreview", preview: pv }))}
            >
              {pv === "off" ? "Off" : `${pv[0]}× device pixels`}
              <span className="sc">{pv === "off" ? "⌃P" : pv === "1x" ? "⌃⌥P" : ""}</span>
              {snap.pixelPreview === pv && <Icon name="check" size={12} className="tick" />}
            </button>
          ))}
          <button role="menuitemcheckbox" aria-checked={snap.viewLayoutGuides} onClick={go(() => engine.dispatch({ type: "toggleLayoutGuides" }))}>
            Layout guides<span className="sc">⇧G</span>
            {snap.viewLayoutGuides && <Icon name="check" size={12} className="tick" />}
          </button>
          <button role="menuitemcheckbox" aria-checked={snap.propertyLabels} onClick={go(() => engine.dispatch({ type: "togglePropertyLabels" }))}>
            Property labels
            {snap.propertyLabels && <Icon name="check" size={12} className="tick" />}
          </button>
          <button role="menuitemcheckbox" aria-checked={snap.showMinimap} onClick={go(() => engine.dispatch({ type: "toggleMinimap" }))}>
            Minimap
            {snap.showMinimap && <Icon name="check" size={12} className="tick" />}
          </button>
          <button role="menuitemcheckbox" aria-checked={snap.showComments} onClick={go(() => engine.dispatch({ type: "toggleComments" }))}>
            Comments
            {snap.showComments && <Icon name="check" size={12} className="tick" />}
          </button>
          <button role="menuitemcheckbox" aria-checked={!!snap.outlineMode} onClick={go(() => engine.dispatch({ type: "toggleOutlines" }))}>
            Layer outlines<span className="sc">⇧O</span>
            {snap.outlineMode && <Icon name="check" size={12} className="tick" />}
          </button>
          <button role="menuitemcheckbox" aria-checked={snap.showFlows !== false} onClick={go(() => engine.dispatch({ type: "toggleFlows" }))}>
            Prototype flows<span className="sc">⇧F</span>
            {snap.showFlows !== false && <Icon name="check" size={12} className="tick" />}
          </button>
          <hr />
          <button role="menuitem" onClick={go(() => window.dispatchEvent(new CustomEvent("x-native-hide-ui")))}>
            Hide UI<span className="sc">⌘\</span>
          </button>
        </div>
      )}
    </div>
  );
}

const ALIGN_LABEL: Record<string, string> = {
  "align-left": "Align left",
  "align-hcenter": "Align horizontal centers",
  "align-right": "Align right",
  "align-top": "Align top",
  "align-vcenter": "Align vertical centers",
  "align-bottom": "Align bottom",
};
const ALIGN_SHORTCUT: Record<string, string> = {
  "align-left": "⌥A",
  "align-hcenter": "⌥H",
  "align-right": "⌥D",
  "align-top": "⌥W",
  "align-vcenter": "⌥V",
  "align-bottom": "⌥S",
};

export function align(
  engine: Engine,
  snap: Snapshot,
  mode:
    | "align-left"
    | "align-hcenter"
    | "align-right"
    | "align-top"
    | "align-vcenter"
    | "align-bottom",
  toParent = false,
) {
  const root = snap.pages[snap.page].root;
  if (toParent && snap.selection.length) {
    engine.dispatch({ type: "begin" });
    for (const id of snap.selection) {
      const n = find(root, id);
      const p = n ? findParent(root, n.id) : null;
      if (!n || !p || p === root) continue;
      let dx = 0;
      let dy = 0;
      if (mode === "align-left") dx = -n.x;
      if (mode === "align-right") dx = p.w - n.w - n.x;
      if (mode === "align-hcenter") dx = (p.w - n.w) / 2 - n.x;
      if (mode === "align-top") dy = -n.y;
      if (mode === "align-bottom") dy = p.h - n.h - n.y;
      if (mode === "align-vcenter") dy = (p.h - n.h) / 2 - n.y;
      if (dx || dy) engine.dispatch({ type: "move", ids: [n.id], dx, dy });
    }
    engine.dispatch({ type: "end" });
    return;
  }
  if (snap.selection.length === 1) {
    const n = find(root, snap.selection[0]);
    const p = n ? findParent(root, n.id) : null;
    if (!n || !p || p === root) return;
    // Children of an auto-layout frame are positioned by the layout engine, so a
    // raw `move` is recomputed away on the next pass and the button looks dead.
    // Figma instead retargets the alignment onto the parent's layout axes, which
    // is the only thing that can actually move the child. Mirror that.
    if (p.layout?.direction === "grid") {
      // "Within a grid auto layout frame, a child object can be aligned to its
      // cell. Select a child object and use the alignment buttons in the
      // Position section" - so on a grid the buttons set the object's own
      // alignment inside its cell, not the parent's packing.
      const isX = mode.startsWith("align-left") || mode.startsWith("align-h") || mode.startsWith("align-r");
      const value = mode.endsWith("center")
        ? "center"
        : mode === "align-left" || mode === "align-top"
          ? "min"
          : "max";
      engine.dispatch({
        type: "patch",
        id: n.id,
        patch: isX ? { constraintH: value } : { constraintV: value },
      });
      return;
    }
    if (p.layout) {
      const horizontal = p.layout.direction === "horizontal";
      const axis: Record<string, LayoutAlign | LayoutJustify> = {
        "align-left": "min",
        "align-hcenter": "center",
        "align-right": "max",
        "align-top": "min",
        "align-vcenter": "center",
        "align-bottom": "max",
      };
      const value = axis[mode];
      const isX = mode.startsWith("align-left") || mode.startsWith("align-h") || mode.startsWith("align-r");
      // On a horizontal stack the main axis is X (justify) and the cross axis is
      // Y (align); on a vertical stack it is the other way around.
      const key = isX === horizontal ? "justify" : "align";
      engine.dispatch({
        type: "patch",
        id: p.id,
        patch: { layout: { ...p.layout, [key]: value } },
      });
      return;
    }
    let dx = 0;
    let dy = 0;
    if (mode === "align-left") dx = -n.x;
    if (mode === "align-right") dx = p.w - n.w - n.x;
    if (mode === "align-hcenter") dx = (p.w - n.w) / 2 - n.x;
    if (mode === "align-top") dy = -n.y;
    if (mode === "align-bottom") dy = p.h - n.h - n.y;
    if (mode === "align-vcenter") dy = (p.h - n.h) / 2 - n.y;
    if (dx || dy) engine.dispatch({ type: "move", ids: [n.id], dx, dy });
    return;
  }
  // On a grid a multi-selection is not one group to align with itself: "If you
  // have multiple child objects selected, each one will align to its respective
  // cell." So every object sets its own alignment inside its own cell, which is
  // the same patch the single-object case sends.
  if (snap.selection.length > 1) {
    const parents = new Set<string>();
    let allGrid = true;
    for (const id of snap.selection) {
      const n = find(root, id);
      const p = n ? findParent(root, n.id) : null;
      if (!n || !p?.layout || p.layout.direction !== "grid") allGrid = false;
      else parents.add(p.id);
    }
    if (allGrid && parents.size === 1) {
      const isX = mode === "align-left" || mode === "align-hcenter" || mode === "align-right";
      const value = mode.endsWith("center")
        ? "center"
        : mode === "align-left" || mode === "align-top"
          ? "min"
          : "max";
      engine.dispatch({ type: "begin" });
      for (const id of snap.selection)
        engine.dispatch({ type: "patch", id, patch: isX ? { constraintH: value } : { constraintV: value } });
      engine.dispatch({ type: "end" });
      return;
    }
  }
  const items = snap.selection
    .map((id) => worldPos(root, id))
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (items.length < 2) return;
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.node.w));
  const minY = Math.min(...items.map((i) => i.y));
  const maxY = Math.max(...items.map((i) => i.y + i.node.h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  engine.dispatch({ type: "begin" });
  for (const it of items) {
    let dx = 0;
    let dy = 0;
    if (mode === "align-left") dx = minX - it.x;
    if (mode === "align-right") dx = maxX - (it.x + it.node.w);
    if (mode === "align-hcenter") dx = cx - (it.x + it.node.w / 2);
    if (mode === "align-top") dy = minY - it.y;
    if (mode === "align-bottom") dy = maxY - (it.y + it.node.h);
    if (mode === "align-vcenter") dy = cy - (it.y + it.node.h / 2);
    if (dx || dy) engine.dispatch({ type: "move", ids: [it.node.id], dx, dy });
  }
  engine.dispatch({ type: "end" });
}
