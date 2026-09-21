import { useState } from "react";
import type {
  AutoLayout,
  Constraint,
  EffectKind,
  Engine,
  ExportFormat,
  ExportPreset,
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
  ProtoAnim,
  ProtoTrigger,
  XNode,
} from "../engine/types";
import { collectColors, defaultEffect, defaultLayout, find, framesOf, worldPos } from "../engine/memory";
import { Icon } from "./icons";
import { FillPicker, type FillValue } from "./FillPicker";
import { isNone } from "./color";
import { ContextMenu, runMenu } from "./ContextMenu";

export function RightPanel({
  engine,
  snap,
  onPresent,
  onShare,
}: {
  engine: Engine;
  snap: Snapshot;
  onPresent?: () => void;
  onShare?: () => void;
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
        <button className="icon-btn" title="Present" onClick={() => onPresent?.()}>
          <Icon name="play" />
        </button>
        <button className="share" onClick={() => onShare?.()}>
          Share
        </button>
      </div>
      <div className="tabs">
        {inspect ? (
          <button className="tab" aria-current="true">
            Inspect
          </button>
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
        <button
          className="zoom"
          title="Zoom"
          onClick={() => {
            const next = snap.zoom >= 1 ? 0.5 : snap.zoom >= 0.5 ? 1 : 2;
            engine.dispatch({ type: "setZoom", zoom: next });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            engine.dispatch({ type: "setZoom", zoom: 1 });
          }}
        >
          {Math.round(snap.zoom * 100)}%
        </button>
      </div>
      <div className="inspector">
        {snap.rightTab === "prototype" && !inspect && (
          <Prototype n={n} engine={engine} snap={snap} onPresent={onPresent} />
        )}
        {inspect && <Inspect n={n} />}
        {snap.rightTab === "design" && !inspect && !n && (
          <PageDesign engine={engine} tool={snap.tool} />
        )}
        {snap.rightTab === "design" && !inspect && n && wp && (
          <Design n={n} x={wp.x} y={wp.y} engine={engine} snap={snap} />
        )}
      </div>
    </aside>
  );
}

const PRESETS: { name: string; w: number; h: number }[] = [
  { name: "iPhone 14", w: 390, h: 844 },
  { name: "iPhone 14 Pro Max", w: 430, h: 932 },
  { name: "Android", w: 360, h: 800 },
  { name: "Desktop", w: 1440, h: 900 },
  { name: "Tablet", w: 768, h: 1024 },
  { name: "Slide 16:9", w: 1920, h: 1080 },
];

function PageDesign({ engine, tool }: { engine: Engine; tool: string }) {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  return (
    <>
      {tool === "frame" && (
        <>
          <div className="h-row">
            <h3>Frame</h3>
          </div>
          <div className="presets">
            {PRESETS.map((p) => (
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
          recents={["#cccccc", "#e6e6e6", "#8a8a8a", "#0d99ff"]}
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
      <div className="proto-preview">
        <div className="phone" style={{ background: n?.fillVisible ? n.fill : "#fff" }} />
      </div>
      <p className="muted">Present opens {startName}. Esc steps back, then exits.</p>
      <div className="h-row">
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
          <div key={i} className="insp-pad" style={{ display: "grid", gap: 4, marginBottom: 8 }}>
            <select
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
            </select>
            <select
              value={ix.action}
              onChange={(e) => {
                const action = e.target.value as Interaction["action"];
                setIx(interactions.map((x, j) => (j === i ? { ...x, action } : x)));
              }}
            >
              <option value="navigate">Navigate to</option>
              <option value="back">Back</option>
            </select>
            {ix.action === "navigate" && (
              <select
                value={ix.destination}
                onChange={(e) =>
                  setIx(interactions.map((x, j) => (j === i ? { ...x, destination: e.target.value } : x)))
                }
              >
                <option value="">Choose frame…</option>
                {frames
                  .filter((f) => f.id !== n.id)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            )}
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
            </select>
            <button
              className="mini minus"
              title="Remove"
              onClick={() => setIx(interactions.filter((_, j) => j !== i))}
            >
              <Icon name="minus" size={12} />
            </button>
          </div>
        ))}
      <div className="insp-pad">
        <button className="export-run" onClick={() => onPresent?.()}>
          Present
        </button>
      </div>
    </>
  );
}

function Inspect({ n }: { n?: XNode }) {
  if (!n) return <p className="empty">Select a layer to inspect</p>;
  const css = [
    `width: ${Math.round(n.w)}px;`,
    `height: ${Math.round(n.h)}px;`,
    n.cornerRadii[0] ? `border-radius: ${n.cornerRadii[0]}px;` : "",
    n.fill && n.fill !== "#00000000" ? `background: ${n.fill};` : "",
    n.opacity < 1 ? `opacity: ${n.opacity};` : "",
    n.layout
      ? `display: flex;\nflex-direction: ${n.layout.direction === "horizontal" ? "row" : "column"};\ngap: ${n.layout.gap}px;`
      : "",
    n.kind === "text"
      ? `font: ${n.fontWeight} ${n.fontSize}px ${n.fontFamily};`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <div className="h-row">
        <h3>CSS</h3>
        <button
          className="plus"
          title="Copy CSS"
          onClick={() => void navigator.clipboard?.writeText(css)}
        >
          <Icon name="copy" size={14} />
        </button>
      </div>
      <pre className="css-block">{css}</pre>
      <p className="muted">Dev Mode — copy CSS from the selected layer.</p>
    </>
  );
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
  const [padOpen, setPadOpen] = useState(false);
  const [conOpen, setConOpen] = useState(false);
  const [cornersOpen, setCornersOpen] = useState(!!n.cornerIndependent);
  const [strokeMore, setStrokeMore] = useState(n.strokeDash > 0);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const multi = snap.selection.length > 1;
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
      if (n.aspectLocked && n.w > 0 && n.h > 0) {
        const ratio = n.h / n.w;
        if (key === "w") h = Math.max(1, v * ratio);
        else w = Math.max(1, v / ratio);
      }
      engine.dispatch({ type: "resize", id: n.id, x: n.x, y: n.y, w, h });
      return;
    }
    engine.dispatch({ type: "patch", id: n.id, patch: { [key]: v } });
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
            { kind: "action", id: "copyCode", label: "Copy as CSS", icon: "code" },
            { kind: "sep" },
            { kind: "action", id: "lockSel", label: "Lock/Unlock", shortcut: "⇧⌘L", icon: "lock" },
            { kind: "action", id: "hideSel", label: "Show/Hide", shortcut: "⇧⌘H", icon: "eye" },
            { kind: "action", id: "delete", label: "Delete", shortcut: "⌫", icon: "trash" },
          ]}
          onRun={(id) => runMenu(engine, id)}
          onClose={() => setMore(null)}
        />
      )}

      {multi && <SelectionColors engine={engine} snap={snap} />}

      <div className="h-row">
        <h3>Position</h3>
      </div>
      <div className="insp-pad">
        <div className="align">
          <div className="g">
            {(["align-left", "align-hcenter", "align-right"] as const).map((ic) => (
              <button key={ic} title={ic} onClick={() => align(engine, snap, ic)}>
                <Icon name={ic} />
              </button>
            ))}
          </div>
          <div className="g">
            {(["align-top", "align-vcenter", "align-bottom"] as const).map((ic) => (
              <button key={ic} title={ic} onClick={() => align(engine, snap, ic)}>
                <Icon name={ic} />
              </button>
            ))}
          </div>
          <div className="g">
            <button title="Distribute horizontal" onClick={() => engine.dispatch({ type: "distribute", axis: "h" })}>
              <Icon name="distribute-h" />
            </button>
            <button title="Distribute vertical" onClick={() => engine.dispatch({ type: "distribute", axis: "v" })}>
              <Icon name="distribute-v" />
            </button>
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
          <Field icon="rotate" value={n.rotation} onChange={(v) => num("rotation", v)} />
          <div className="seg">
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

      <div className="hr" />
      <div className="h-row">
        <h3>Layout</h3>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            className="plus"
            title="Add auto layout"
            onClick={() =>
              engine.dispatch({
                type: "autoLayout",
                id: n.id,
                layout: n.layout ? null : defaultLayout(),
              })
            }
          >
            <Icon name={n.layout ? "minus" : "plus"} size={14} />
          </button>
        </div>
      </div>
      <div className="dir-row">
        <div className="seg">
          <button
            className={!n.layout ? "on" : ""}
            title="None"
            onClick={() => engine.dispatch({ type: "autoLayout", id: n.id, layout: null })}
          >
            <Icon name="layout-none" />
          </button>
          <button
            className={n.layout?.direction === "vertical" ? "on" : ""}
            title="Vertical"
            onClick={() => setDir(engine, n, "vertical")}
          >
            <Icon name="layout-v" />
          </button>
          <button
            className={n.layout?.direction === "horizontal" ? "on" : ""}
            title="Horizontal"
            onClick={() => setDir(engine, n, "horizontal")}
          >
            <Icon name="layout-h" />
          </button>
          <button
            className={n.layout?.wrap && n.layout.direction === "horizontal" ? "on" : ""}
            title="Grid"
            onClick={() =>
              engine.dispatch({
                type: "autoLayout",
                id: n.id,
                layout: { ...(n.layout ?? defaultLayout()), direction: "horizontal", wrap: true, gap: 8 },
              })
            }
          >
            <Icon name="layout-grid" />
          </button>
          <button
            className={n.layout?.wrap ? "on" : ""}
            title="Wrap"
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
            hint={n.sizingW}
            value={n.w}
            onChange={(v) => num("w", v)}
            onLabelClick={() => {
              const sizingW = cycleSizing(n.sizingW);
              patch({ sizingW });
              if (n.layout && (sizingW === "hug" || sizingW === "fixed")) {
                engine.dispatch({
                  type: "autoLayout",
                  id: n.id,
                  layout: { ...n.layout, sizing: sizingW === "hug" ? "hug" : "fixed" },
                });
              }
            }}
          />
          <Field
            label="H"
            hint={n.sizingH}
            value={n.h}
            onChange={(v) => num("h", v)}
            onLabelClick={() => {
              const sizingH = cycleSizing(n.sizingH);
              patch({ sizingH });
              if (n.layout && (sizingH === "hug" || sizingH === "fixed")) {
                engine.dispatch({
                  type: "autoLayout",
                  id: n.id,
                  layout: { ...n.layout, cross: sizingH === "hug" ? "hug" : "fixed" },
                });
              }
            }}
          />
          <button
            className={`icon-btn${n.aspectLocked ? " on" : ""}`}
            title={n.aspectLocked ? "Unlock aspect ratio" : "Lock aspect ratio"}
            onClick={() => patch({ aspectLocked: !n.aspectLocked })}
          >
            <Icon name="aspect" size={14} />
          </button>
        </div>
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
        Clip content
      </label>
      {n.layout && (
        <>
          <div className="dir-row">
            <Nine
              layout={n.layout}
              onChange={(patch) =>
                engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, ...patch } })
              }
            />
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
          </div>
          <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
            <Field
              icon="gap"
              value={n.layout.gap}
              onChange={(v) =>
                engine.dispatch({ type: "autoLayout", id: n.id, layout: { ...n.layout!, gap: v } })
              }
            />
            {padOpen ? (
              <div className="grid2">
                {(["L", "R", "T", "B"] as const).map((lab, i) => (
                  <Field
                    key={lab}
                    label={lab}
                    value={n.layout!.padding[i]}
                    onChange={(v) => {
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
              <Field
                icon="padding"
                value={n.layout.padding[0]}
                onChange={(v) =>
                  engine.dispatch({
                    type: "autoLayout",
                    id: n.id,
                    layout: { ...n.layout!, padding: [v, v, v, v] },
                  })
                }
              />
            )}
            <button
              className="icon-btn"
              title="Independent padding"
              onClick={() => setPadOpen((v) => !v)}
            >
              <Icon name="independent" size={14} />
            </button>
          </div>
        </>
      )}

      <div className="hr" />
      <div className="h-row">
        <h3>Appearance</h3>
      </div>
      <div className="insp-pad">
        <div className="grid2">
          <div className="field">
            <select
              value={n.blendMode}
              onChange={(e) =>
                engine.dispatch({ type: "patch", id: n.id, patch: { blendMode: e.target.value } })
              }
            >
              {["normal", "multiply", "screen", "overlay", "darken", "lighten"].map((m) => (
                <option key={m} value={m}>
                  {m === "normal" ? "Pass through" : m[0].toUpperCase() + m.slice(1)}
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
        {cornersOpen ? (
          <div className="grid2">
            {(["TL", "TR", "BL", "BR"] as const).map((lab, i) => (
              <Field
                key={lab}
                label={lab}
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
              value={n.cornerRadii[0]}
              onChange={(v) => patch({ cornerRadii: [v, v, v, v] })}
            />
            <span />
            <button
              className={`icon-btn${cornersOpen ? " on" : ""}`}
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

      <div className="hr" />
      <div className="h-row">
        <h3>Fill</h3>
        <button
          className="plus"
          title="Add fill"
          onClick={() =>
            engine.dispatch({
              type: "patch",
              id: n.id,
              patch: {
                fill: isNone(n.fill) ? "#d9d9d9" : n.fill,
                fillVisible: true,
                fillOpacity: n.fillOpacity ?? 1,
              },
            })
          }
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {n.fillVisible && !isNone(n.fill) && (
        <div className="insp-pad">
          <ColorRow
            value={n.fill}
            opacity={Math.round((n.fillOpacity ?? 1) * 100)}
            visible={n.fillVisible}
            type={n.fillType}
            second={n.fillB}
            blend={n.fillBlend}
            recents={collectColors(snap.pages[snap.page].root)}
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
          />
        </div>
      )}

      <div className="h-row">
        <h3>Stroke</h3>
        <button
          className="plus"
          title="Add stroke"
          onClick={() =>
            engine.dispatch({
              type: "patch",
              id: n.id,
              patch: {
                strokePaint: isNone(n.strokePaint) ? "#1e1e1e" : n.strokePaint,
                strokeVisible: true,
                strokeWidth: n.strokeWidth || 1,
              },
            })
          }
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint) && (
        <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
          <ColorRow
            title="Stroke"
            value={n.strokePaint}
            opacity={Math.round((n.strokeOpacity ?? 1) * 100)}
            visible={n.strokeVisible}
            recents={collectColors(snap.pages[snap.page].root)}
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
          <div className="grid3">
            <Field
              label="W"
              value={n.strokeWidth}
              onChange={(strokeWidth) =>
                engine.dispatch({ type: "patch", id: n.id, patch: { strokeWidth } })
              }
            />
            <div className="seg">
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
          <button
            className={`icon-btn${strokeMore ? " on" : ""}`}
            title="Dash, cap, join"
            onClick={() => setStrokeMore((v) => !v)}
          >
            <Icon name="dash" size={14} />
          </button>
          {strokeMore && (
            <>
              <div className="grid2">
                <Field label="–" value={n.strokeDash} onChange={(strokeDash) => patch({ strokeDash })} />
                <Field
                  label="gap"
                  value={n.strokeGap || n.strokeDash}
                  onChange={(strokeGap) => patch({ strokeGap })}
                />
              </div>
              <div className="seg">
                {(["none", "round", "square", "arrow"] as StrokeCap[]).map((c) => (
                  <button
                    key={c}
                    className={n.strokeCap === c ? "on" : ""}
                    title={`Cap ${c}`}
                    onClick={() => patch({ strokeCap: c })}
                  >
                    <Icon name={c === "arrow" ? "arrow" : `cap-${c}`} size={14} />
                  </button>
                ))}
              </div>
              <div className="seg">
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
            </>
          )}
        </div>
      )}

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
              onChange={(count) => patch({ count: Math.max(3, Math.round(count)) })}
            />
            {n.kind === "star" && (
              <Field
                label="%"
                value={Math.round((n.starRatio || 0.4) * 100)}
                onChange={(v) => patch({ starRatio: Math.max(0.05, Math.min(0.95, v / 100)) })}
              />
            )}
          </div>
        </>
      )}

      {n.kind === "text" && (
        <>
          <div className="hr" />
          <div className="h-row">
            <h3>Typography</h3>
            <button className="plus" title="Type settings" onClick={() => setTypeOpen((v) => !v)}>
              <Icon name="type-settings" size={14} />
            </button>
          </div>
          <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
            <div className="field">
              <select
                value={n.fontFamily}
                onChange={(e) =>
                  engine.dispatch({ type: "patch", id: n.id, patch: { fontFamily: e.target.value } })
                }
              >
                {["Inter", "Roboto", "SF Pro", "Geist", "Space Grotesk"].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="grid2">
              <div className="field">
                <select
                  value={n.fontWeight}
                  onChange={(e) =>
                    engine.dispatch({
                      type: "patch",
                      id: n.id,
                      patch: { fontWeight: parseInt(e.target.value, 10) },
                    })
                  }
                >
                  <option value={400}>Regular</option>
                  <option value={500}>Medium</option>
                  <option value={600}>Semi Bold</option>
                  <option value={700}>Bold</option>
                </select>
              </div>
              <Field label="S" value={n.fontSize} onChange={(v) => num("fontSize", v)} />
              <Field
                label="↑"
                value={n.lineHeight || n.fontSize * 1.2}
                onChange={(v) => num("lineHeight", v)}
              />
              <Field label="↔" value={n.letterSpacing} onChange={(v) => num("letterSpacing", v)} />
            </div>
            <div className="seg">
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
            <div className="seg">
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
                <div className="seg">
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
                  <button
                    className={n.textCase === "upper" ? "on" : ""}
                    onClick={() =>
                      engine.dispatch({
                        type: "patch",
                        id: n.id,
                        patch: { textCase: n.textCase === "upper" ? "none" : "upper" },
                      })
                    }
                  >
                    TT
                  </button>
                </div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={n.truncate}
                  onChange={(e) =>
                    engine.dispatch({ type: "patch", id: n.id, patch: { truncate: e.target.checked } })
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
                      engine.dispatch({ type: "patch", id: n.id, patch: { maxLines: v } })
                    }
                  />
                </div>
              )}
              <div className="insp-pad">
                <Field
                  label="¶"
                  value={n.paragraphSpacing}
                  onChange={(v) => num("paragraphSpacing", v)}
                />
              </div>
            </div>
          )}
        </>
      )}

      <div className="hr" />
      <Effects n={n} engine={engine} />
      <ExportBlock n={n} engine={engine} />
    </>
  );
}

function Effects({ n, engine }: { n: XNode; engine: Engine }) {
  const [open, setOpen] = useState(false);
  const kinds: { id: EffectKind; label: string }[] = [
    { id: "drop-shadow", label: "Drop shadow" },
    { id: "inner-shadow", label: "Inner shadow" },
    { id: "layer-blur", label: "Layer blur" },
    { id: "background-blur", label: "Background blur" },
  ];
  return (
    <>
      <div className="h-row" style={{ position: "relative" }}>
        <h3>Effects</h3>
        <button className="plus" title="Add effect" onClick={() => setOpen((v) => !v)}>
          <Icon name="plus" size={14} />
        </button>
        {open && (
          <div className="type-menu" style={{ right: 8, top: 28, left: "auto", width: 180 }}>
            {kinds.map((k) => (
              <button
                key={k.id}
                onClick={() => {
                  engine.dispatch({
                    type: "patch",
                    id: n.id,
                    patch: { effects: [...(n.effects ?? []), defaultEffect(k.id)] },
                  });
                  setOpen(false);
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {(n.effects ?? []).map((fx, i) => (
        <div key={i} className="insp-pad" style={{ marginBottom: 4 }}>
          <div className="color-row">
            <span className="swatch" style={{ background: fx.color }} />
            <span className="hex">{kinds.find((k) => k.id === fx.kind)?.label}</span>
            <input
              className="op"
              value={fx.blur}
              onChange={(e) => {
                const blur = parseFloat(e.target.value);
                if (Number.isNaN(blur)) return;
                const effects = (n.effects ?? []).map((e2, j) => (j === i ? { ...e2, blur } : e2));
                engine.dispatch({ type: "patch", id: n.id, patch: { effects } });
              }}
            />
            <button
              className="mini"
              title={fx.visible ? "Hide" : "Show"}
              onClick={() => {
                const effects = (n.effects ?? []).map((e2, j) =>
                  j === i ? { ...e2, visible: !e2.visible } : e2,
                );
                engine.dispatch({ type: "patch", id: n.id, patch: { effects } });
              }}
            >
              <Icon name={fx.visible ? "eye" : "eye-off"} size={14} />
            </button>
            <button
              className="mini minus"
              title="Remove"
              onClick={() => {
                const effects = (n.effects ?? []).filter((_, j) => j !== i);
                engine.dispatch({ type: "patch", id: n.id, patch: { effects } });
              }}
            >
              <Icon name="minus" size={14} />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function Nine({
  layout,
  onChange,
}: {
  layout: AutoLayout;
  onChange: (p: Partial<AutoLayout>) => void;
}) {
  const cells: { j: LayoutJustify; a: LayoutAlign }[] = [
    { j: "min", a: "min" },
    { j: "center", a: "min" },
    { j: "max", a: "min" },
    { j: "min", a: "center" },
    { j: "center", a: "center" },
    { j: "max", a: "center" },
    { j: "min", a: "max" },
    { j: "center", a: "max" },
    { j: "max", a: "max" },
  ];
  const jj = layout.justify === "between" ? "min" : layout.justify;
  return (
    <div className="nine" title="Alignment">
      {cells.map((c, i) => (
        <button
          key={i}
          className={jj === c.j && layout.align === c.a ? "on" : ""}
          onClick={() => onChange({ justify: c.j, align: c.a })}
        />
      ))}
    </div>
  );
}

function Field({
  label,
  icon,
  value,
  onChange,
  hint,
  onLabelClick,
}: {
  label?: string;
  icon?: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  onLabelClick?: () => void;
}) {
  return (
    <div className="field">
      {icon ? (
        <Icon name={icon} size={14} />
      ) : (
        <label
          title={hint ? `${label} · ${hint}` : label}
          onClick={onLabelClick}
          style={onLabelClick ? { cursor: "pointer" } : undefined}
        >
          {label}
        </label>
      )}
      <input
        value={fmt(value)}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
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

function SelectionColors({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const root = snap.pages[snap.page].root;
  const rows: { id: string; fill: string; opacity: number }[] = [];
  const seen = new Set<string>();
  for (const id of snap.selection) {
    const n = find(root, id);
    if (!n || !n.fillVisible || isNone(n.fill)) continue;
    const key = n.fill.slice(0, 7).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: n.id, fill: n.fill, opacity: Math.round((n.fillOpacity ?? 1) * 100) });
  }
  if (!rows.length) return null;
  return (
    <>
      <div className="h-row">
        <h3>Selection colors</h3>
      </div>
      <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
        {rows.map((r) => (
          <ColorRow
            key={r.id}
            value={r.fill}
            opacity={r.opacity}
            visible
            recents={collectColors(root)}
            onChange={(fill) => {
              for (const id of snap.selection) {
                const n = find(root, id);
                if (n && n.fill.slice(0, 7).toLowerCase() === r.fill.slice(0, 7).toLowerCase()) {
                  engine.dispatch({ type: "patch", id, patch: { fill, fillVisible: true } });
                }
              }
            }}
            onOpacity={(v) => engine.dispatch({ type: "patch", id: r.id, patch: { fillOpacity: v / 100 } })}
          />
        ))}
      </div>
      <div className="hr" />
    </>
  );
}

const FORMATS: ExportFormat[] = ["PNG", "JPG", "SVG", "PDF"];
const SCALES = [0.5, 1, 2, 3, 4];

function ExportBlock({ n, engine }: { n: XNode; engine: Engine }) {
  const presets = n.exports ?? [];
  const add = () =>
    engine.dispatch({
      type: "patch",
      id: n.id,
      patch: { exports: [...presets, { format: "PNG", scale: 1, suffix: "" }] },
    });
  const set = (i: number, p: ExportPreset) => {
    const next = presets.map((e, j) => (j === i ? p : e));
    engine.dispatch({ type: "patch", id: n.id, patch: { exports: next } });
  };
  return (
    <>
      <div className="h-row">
        <h3>Export</h3>
        <button className="plus" title="Add export" onClick={add}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {presets.map((p, i) => (
        <div key={i} className="insp-pad" style={{ marginBottom: 4 }}>
          <div className="export-row">
            <button
              className="fmt"
              title="Format"
              onClick={() => set(i, { ...p, format: FORMATS[(FORMATS.indexOf(p.format) + 1) % FORMATS.length] })}
            >
              {p.format}
            </button>
            <button
              className="fmt"
              title="Scale"
              onClick={() => set(i, { ...p, scale: SCALES[(SCALES.indexOf(p.scale) + 1) % SCALES.length] })}
            >
              {p.scale}×
            </button>
            <input
              className="suffix"
              placeholder="suffix"
              value={p.suffix}
              onChange={(e) => set(i, { ...p, suffix: e.target.value })}
            />
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
        </div>
      ))}
      {!!presets.length && (
        <div className="insp-pad">
          <button className="export-run" onClick={() => presets.forEach((p) => runExport(n, p))}>
            Export
          </button>
        </div>
      )}
    </>
  );
}

function runExport(n: XNode, p: ExportPreset) {
  const w = Math.max(1, Math.round(n.w * p.scale));
  const h = Math.max(1, Math.round(n.h * p.scale));
  const name = `${n.name}${p.suffix}.${p.format.toLowerCase()}`;
  const fill = n.fillVisible && !isNone(n.fill) ? n.fill : "none";
  if (p.format === "SVG" || p.format === "PDF") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${Math.round(n.w)} ${Math.round(n.h)}">${n.kind === "ellipse" ? `<ellipse cx="${n.w / 2}" cy="${n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}" fill="${fill}"/>` : `<rect width="${n.w}" height="${n.h}" rx="${n.cornerRadii[0]}" fill="${fill}"/>`}${n.strokeVisible && n.strokeWidth ? `<rect width="${n.w}" height="${n.h}" fill="none" stroke="${n.strokePaint}" stroke-width="${n.strokeWidth}"/>` : ""}</svg>`;
    const a = document.createElement("a");
    a.download = name.replace(/\.pdf$/, ".svg");
    a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    a.click();
    return;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  if (p.format === "JPG") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  if (fill !== "none") {
    ctx.fillStyle = fill;
    const r = n.cornerRadii[0] * p.scale;
    if (n.kind === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, w, h);
    }
  }
  c.toBlob(
    (b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.download = name;
      a.href = URL.createObjectURL(b);
      a.click();
    },
    p.format === "JPG" ? "image/jpeg" : "image/png",
    0.92,
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
  recents = [],
  onChange,
  onOpacity,
  onVisible,
  onRemove,
  onMeta,
}: {
  title?: string;
  value: string;
  opacity?: number;
  visible?: boolean;
  type?: FillValue["type"];
  second?: string;
  blend?: string;
  recents?: string[];
  onChange: (v: string) => void;
  onOpacity?: (v: number) => void;
  onVisible?: (v: boolean) => void;
  onRemove?: () => void;
  onMeta?: (p: Partial<XNode>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hidden = !visible || isNone(value);
  const hex = value.length >= 7 ? value.slice(0, 7) : "#000000";
  return (
    <div className="color-row">
      <button
        type="button"
        className="swatch"
        style={{ background: hidden ? "transparent" : hex }}
        title="Color picker"
        onClick={(e) => {
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
          setOpen(true);
        }}
      />
      <input
        className="hex"
        value={hidden ? "" : hex.replace("#", "")}
        placeholder="None"
        onChange={(e) => onChange("#" + e.target.value.replace("#", ""))}
      />
      {onOpacity && (
        <input
          className="op"
          value={`${opacity}%`}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onOpacity(v);
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
          value={{ color: hex, opacity, type, second, blend }}
          recents={recents}
          anchor={anchor}
          onChange={(v) => {
            onChange(v.color);
            onOpacity?.(v.opacity);
            onMeta?.({ fillType: v.type, fillB: v.second, fillBlend: v.blend, fillVisible: true });
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function fmt(v: number) {
  const r = Math.round(v);
  return Math.abs(v - r) < 0.05 ? String(r) : v.toFixed(1);
}

function setDir(engine: Engine, n: XNode, direction: "horizontal" | "vertical") {
  engine.dispatch({
    type: "autoLayout",
    id: n.id,
    layout: { ...(n.layout ?? defaultLayout()), direction },
  });
}

function align(
  engine: Engine,
  snap: Snapshot,
  mode:
    | "align-left"
    | "align-hcenter"
    | "align-right"
    | "align-top"
    | "align-vcenter"
    | "align-bottom",
) {
  const root = snap.pages[snap.page].root;
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
