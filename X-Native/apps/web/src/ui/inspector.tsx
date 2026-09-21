import { useState } from "react";
import type {
  AutoLayout,
  EffectKind,
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
import { collectColors, defaultEffect, defaultLayout, worldPos } from "../engine/memory";
import { Icon } from "./icons";
import { FillPicker, type FillValue } from "./FillPicker";
import { isNone } from "./color";

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
        <h3>Export</h3>
        <button className="plus" title="Add export">
          <Icon name="plus" size={14} />
        </button>
      </div>
    </>
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
              onClick={() => engine.dispatch({ type: "flip", axis: "h" })}
            >
              <Icon name="flip-h" size={14} />
            </button>
            <button title="Flip vertical" onClick={() => engine.dispatch({ type: "flip", axis: "v" })}>
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
      <div className="insp-pad" style={{ marginTop: 4 }}>
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
        </div>
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
      <div className="h-row">
        <h3>Export</h3>
        <button
          className="plus"
          title="Add export"
          onClick={() => {
            const a = document.createElement("a");
            a.download = `${n.name}.svg`;
            a.href = URL.createObjectURL(
              new Blob(
                [
                  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(n.w)}" height="${Math.round(n.h)}"><rect width="100%" height="100%" fill="${n.fillVisible ? n.fill : "none"}"/></svg>`,
                ],
                { type: "image/svg+xml" },
              ),
            );
            a.click();
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="insp-pad">
        <div className="color-row">
          <span className="hex">PNG</span>
          <span className="op">1×</span>
        </div>
      </div>
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
