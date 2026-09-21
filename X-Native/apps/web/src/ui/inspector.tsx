import { useState } from "react";
import type {
  AutoLayout,
  Engine,
  LayoutAlign,
  LayoutJustify,
  RightTab,
  Snapshot,
  StrokeAlign,
  TextAlign,
  TextAlignVertical,
  XNode,
} from "../engine/types";
import { defaultLayout, worldPos } from "../engine/memory";
import { Icon } from "./icons";

export function RightPanel({
  engine,
  snap,
}: {
  engine: Engine;
  snap: Snapshot;
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
        <button className="icon-btn" title="Present">
          <Icon name="play" />
        </button>
        <button className="share">Share</button>
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
        {snap.rightTab === "prototype" && !inspect && <Prototype n={n} />}
        {inspect && <Inspect n={n} />}
        {snap.rightTab === "design" && !inspect && !n && (
          <p className="empty">Select a layer to edit properties</p>
        )}
        {snap.rightTab === "design" && !inspect && n && wp && (
          <Design n={n} x={wp.x} y={wp.y} engine={engine} snap={snap} />
        )}
      </div>
    </aside>
  );
}

function Prototype({ n }: { n?: XNode }) {
  return (
    <>
      <div className="h-row">
        <h3>Prototype settings</h3>
      </div>
      <div className="proto-row">
        <span>Device</span>
        <strong>{n?.kind === "frame" ? "iPhone 14" : "None"}</strong>
      </div>
      <div className="proto-row">
        <span>Model</span>
        <strong>Black</strong>
      </div>
      <div className="proto-row">
        <span>Background</span>
        <strong>000000</strong>
      </div>
      <div className="proto-preview">
        <div className="phone" />
      </div>
      <div className="h-row">
        <h3>Flows</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <p className="muted">
        Drag the blue node on a selected frame to connect a flow. Interactions
        live on this tab in Figma.
      </p>
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
      </div>
      <pre className="css-block">{css}</pre>
      <p className="muted">Dev Mode — iOS, Android, and Tailwind live in native Inspect.</p>
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
      engine.dispatch({
        type: "resize",
        id: n.id,
        x: n.x,
        y: n.y,
        w: key === "w" ? v : n.w,
        h: key === "h" ? v : n.h,
      });
      return;
    }
    engine.dispatch({ type: "patch", id: n.id, patch: { [key]: v } });
  };
  const kindLabel =
    n.imageSrc ? "Image" : n.kind === "rect" ? "Rectangle" : n.kind[0].toUpperCase() + n.kind.slice(1);
  return (
    <>
      <div className="layer-type">
        <span className="kind">{kindLabel}</span>
        <span className="grow" />
        <button
          className="icon-btn"
          title="Dev Mode"
          onClick={() => engine.dispatch({ type: "setRightTab", tab: "inspect" })}
        >
          <Icon name="dev" size={14} />
        </button>
        <button className="icon-btn" title="More">
          <Icon name="more" size={14} />
        </button>
      </div>

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
        </div>
        <div className="grid3">
          <Field label="X" value={x} onChange={(v) => num("x", v)} />
          <Field label="Y" value={y} onChange={(v) => num("y", v)} />
          <button className="icon-btn" title="Constraints">
            <Icon name="constraints" size={14} />
          </button>
          <Field icon="rotate" value={n.rotation} onChange={(v) => num("rotation", v)} />
          <div className="seg">
            <button
              title="Flip horizontal"
              onClick={() => engine.dispatch({ type: "patch", id: n.id, patch: { w: n.w } })}
            >
              <Icon name="flip-h" size={14} />
            </button>
            <button title="Flip vertical">
              <Icon name="flip-v" size={14} />
            </button>
          </div>
        </div>
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
          <button title="Grid">
            <Icon name="layout-grid" />
          </button>
        </div>
      </div>
      <div className="insp-pad">
        <div className="grid3">
          <Field label="W" value={n.w} onChange={(v) => num("w", v)} />
          <Field label="H" value={n.h} onChange={(v) => num("h", v)} />
          <button
            className="icon-btn"
            title="Clip content"
            onClick={() =>
              engine.dispatch({
                type: "patch",
                id: n.id,
                patch: { overflow: n.overflow === "visible" ? "clip" : "visible" },
              })
            }
          >
            <Icon name="clip" size={14} />
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
        <button className="icon-btn" title="Visible">
          <Icon name={n.visible ? "eye" : "eye-off"} size={14} />
        </button>
      </div>
      <div className="insp-pad">
        <div className="grid2">
          <Field
            label="%"
            value={Math.round(n.opacity * 100)}
            onChange={(v) => num("opacity", v / 100)}
          />
          <Field
            icon="radius"
            value={n.cornerRadii[0]}
            onChange={(v) =>
              engine.dispatch({
                type: "patch",
                id: n.id,
                patch: { cornerRadii: [v, v, v, v] },
              })
            }
          />
        </div>
      </div>

      <div className="hr" />
      <div className="h-row">
        <h3>Fill</h3>
        <button className="plus" title="Add fill">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="insp-pad">
        <ColorRow
          value={n.fill}
          opacity={Math.round(n.opacity * 100)}
          onChange={(fill) => engine.dispatch({ type: "patch", id: n.id, patch: { fill } })}
          onOpacity={(v) => num("opacity", v / 100)}
        />
      </div>

      <div className="h-row">
        <h3>Stroke</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
        <ColorRow
          value={n.strokePaint}
          opacity={100}
          onChange={(strokePaint) =>
            engine.dispatch({ type: "patch", id: n.id, patch: { strokePaint } })
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
      </div>

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
      <div className="h-row">
        <h3>Effects</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="h-row">
        <h3>Export</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
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
}: {
  label?: string;
  icon?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      {icon ? <Icon name={icon} size={14} /> : <label>{label}</label>}
      <input
        value={fmt(value)}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

function ColorRow({
  value,
  opacity = 100,
  onChange,
  onOpacity,
}: {
  value: string;
  opacity?: number;
  onChange: (v: string) => void;
  onOpacity?: (v: number) => void;
}) {
  const hex = value.length >= 7 ? value.slice(0, 7) : "#000000";
  return (
    <div className="color-row">
      <label className="swatch" style={{ background: hex === "#00000000" ? "#fff" : hex }}>
        <input
          type="color"
          value={hex === "#00000000" ? "#ffffff" : hex}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <input
        className="hex"
        value={hex.replace("#", "")}
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
