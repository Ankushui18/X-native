import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type { Engine, Interaction, ProtoDevice, Snapshot, XNode } from "../engine/types";
import { find, worldPos } from "../engine/memory";
import { Icon, rowIconSize } from "./icons";
import { DEVICE_GROUPS, DeviceShell, deviceBox, deviceFor } from "./devices";

// Web Audio API synthesizer for tactile prototype sound feedback
let audioCtx: AudioContext | null = null;
function playTapSound(freq = 750, duration = 0.04) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, audioCtx.currentTime + duration);

    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

interface HotspotBox {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  interaction: Interaction;
}

interface FormFieldItem {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  isToggle?: boolean;
}

export function PresentationPlayer({
  engine,
  snap,
  onExit,
  onInteraction,
}: {
  engine: Engine;
  snap: Snapshot;
  onExit: () => void;
  onInteraction?: (ix: Interaction) => void;
}) {
  const root = snap.pages[snap.page].root;
  const presentNode = snap.presentFrame ? find(root, snap.presentFrame) : null;
  const wp = presentNode ? worldPos(root, presentNode.id) : null;

  // Local live form inputs state (nodeId -> typed value)
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [toggleValues, setToggleValues] = useState<Record<string, boolean>>({});

  // Hotspot pulse & ripple
  const [hotspotPulse, setHotspotPulse] = useState(false);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  // Dock auto-hide
  const [dockVisible, setDockVisible] = useState(true);
  const dockTimeout = useRef<number | null>(null);

  // Device & scale preferences
  const device = snap.prototypeDevice ?? "none";
  const hotspotsActive = snap.prototypeHotspots ?? true;
  const liveInputsActive = snap.prototypeLiveInputs ?? true;
  const soundActive = snap.prototypeSound ?? true;
  const scaleMode = snap.prototypeScale ?? "fit";

  // All frames in document
  const allFrames = useMemo(() => {
    const list: XNode[] = [];
    const walk = (n: XNode) => {
      if (n !== root && n.kind === "frame") list.push(n);
      for (const ch of n.children) walk(ch);
    };
    walk(root);
    return list;
  }, [root]);

  // Current frame index
  const curIndex = allFrames.findIndex((f) => f.id === snap.presentFrame);

  // Collect clickable hotspots inside active frame
  const hotspots = useMemo(() => {
    if (!presentNode) return [];
    const list: HotspotBox[] = [];
    const collect = (n: XNode, px: number, py: number) => {
      const x = px + n.x;
      const y = py + n.y;
      const ix = (n.interactions ?? []).find((i) => i.trigger === "onClick");
      if (ix) {
        list.push({ id: n.id, name: n.name, x, y, w: n.w, h: n.h, interaction: ix });
      }
      for (const ch of n.children) collect(ch, x, y);
    };
    for (const ch of presentNode.children) collect(ch, 0, 0);
    return list;
  }, [presentNode]);

  // Collect interactive text/form fields
  const formFields = useMemo(() => {
    if (!presentNode || !liveInputsActive) return [];
    const list: FormFieldItem[] = [];
    const isInputName = (name: string) =>
      /input|field|search|email|password|text|form|comment/i.test(name);
    const isToggleName = (name: string) => /switch|toggle|checkbox|check/i.test(name);

    const collect = (n: XNode, px: number, py: number) => {
      const x = px + n.x;
      const y = py + n.y;
      if (isToggleName(n.name)) {
        list.push({ id: n.id, name: n.name, kind: n.kind, x, y, w: n.w, h: n.h, isToggle: true });
      } else if (n.kind === "text" && (isInputName(n.name) || n.text?.startsWith("Enter ") || n.text?.startsWith("Search"))) {
        list.push({ id: n.id, name: n.name, kind: n.kind, x, y, w: n.w, h: n.h, text: n.text });
      } else if (isInputName(n.name) && n.children.length === 0) {
        list.push({ id: n.id, name: n.name, kind: n.kind, x, y, w: n.w, h: n.h });
      }
      for (const ch of n.children) collect(ch, x, y);
    };
    for (const ch of presentNode.children) collect(ch, 0, 0);
    return list;
  }, [presentNode, liveInputsActive]);

  const spec = deviceFor(device);

  // Fit the device — shell and safe-area bands included — into the viewport, and
  // shift the design down inside the glass so the status bar does not land on
  // top of the design's first line. The engine only knows the frame's own rect.
  useEffect(() => {
    if (!presentNode) return;
    const box = deviceBox(spec, presentNode.w, presentNode.h);
    const mode = snap.prototypeScale ?? "fit";
    const vw = window.innerWidth;
    const vh = Math.max(240, window.innerHeight - 150);
    const z =
      mode === "100%"
        ? 1
        : mode === "fill"
          ? Math.max(vw / box.w, (vh + 200) / box.h)
          : Math.min(1, Math.min((vw - 80) / box.w, vh / box.h));
    engine.dispatch({ type: "setZoom", zoom: z });
    engine.dispatch({
      type: "setPan",
      x: Math.round((vw - box.w * z) / 2 + box.bezShift * z - (wp?.x ?? 0) * z),
      y: Math.round((vh - box.glassH * z) / 2 - ((wp?.y ?? 0) - box.pad.top) * z),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, snap.presentFrame, snap.prototypeScale, snap.prototypeOrientation]);

  // Screen coordinates of present frame
  const z = snap.zoom;
  const frameX = wp ? snap.panX + wp.x * z : 0;
  const frameY = wp ? snap.panY + wp.y * z : 0;
  const frameW = presentNode ? presentNode.w * z : 0;
  const frameH = presentNode ? presentNode.h * z : 0;

  // Handle missed click -> pulse hotspots and trigger ripple
  const handleMissedClick = useCallback((e: React.MouseEvent) => {
    if (soundActive) playTapSound(320, 0.03);
    const newRipple = { id: Date.now(), x: e.clientX, y: e.clientY };
    setRipples((prev) => [...prev, newRipple]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
    }, 600);

    setHotspotPulse(true);
    setTimeout(() => setHotspotPulse(false), 550);
  }, [soundActive]);

  // Execute hotspot interaction
  const triggerHotspot = useCallback((ix: Interaction) => {
    if (soundActive) playTapSound(880, 0.05);
    if (onInteraction) {
      onInteraction(ix);
      return;
    }
    if (ix.action === "back") {
      engine.dispatch({ type: "presentBack" });
    } else if (ix.action === "navigate" && ix.destination) {
      engine.dispatch({ type: "presentGo", id: ix.destination });
    } else if (ix.action === "openOverlay" && ix.destination) {
      engine.dispatch({
        type: "openOverlay",
        id: ix.destination,
        position: ix.overlayPosition || "center",
        closeOutside: ix.overlayCloseOutside !== false,
        backdrop: ix.overlayBackdrop !== false,
        backdropColor: ix.overlayBackdropColor,
      });
    } else if (ix.action === "closeOverlay") {
      engine.dispatch({ type: "closeOverlay" });
    } else if (ix.action === "openUrl" && ix.destination) {
      const url = /^https?:\/\//i.test(ix.destination) ? ix.destination : `https://${ix.destination}`;
      window.open(url, "_blank", "noopener,noreferrer");
    } else if (ix.action === "setVariable" && ix.variableId) {
      const v = snap.variables?.find((varItem) => varItem.id === ix.variableId);
      if (v) {
        let nextVal = ix.variableValue !== undefined ? ix.variableValue : v.value;
        if (ix.variableOp === "increment" && typeof v.value === "number") nextVal = v.value + 1;
        else if (ix.variableOp === "decrement" && typeof v.value === "number") nextVal = v.value - 1;
        else if (ix.variableOp === "toggle") nextVal = !v.value;
        engine.dispatch({ type: "patchVariable", id: ix.variableId, patch: { value: nextVal } });
      }
    }
  }, [engine, snap.variables, soundActive]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "Escape") {
        if (snap.activeOverlay) {
          engine.dispatch({ type: "closeOverlay" });
        } else if (snap.presentStack.length > 1) {
          engine.dispatch({ type: "presentBack" });
        } else {
          onExit();
        }
      } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
        if (curIndex > 0) {
          const target = allFrames[curIndex - 1];
          if (onInteraction) {
            onInteraction({ trigger: "onClick", action: "navigate", destination: target.id, animation: "smart", delay: 0 });
          } else {
            engine.dispatch({ type: "presentGo", id: target.id });
          }
        }
      } else if (e.key === "ArrowRight" || e.key === " ") {
        if (curIndex < allFrames.length - 1) {
          const target = allFrames[curIndex + 1];
          if (onInteraction) {
            onInteraction({ trigger: "onClick", action: "navigate", destination: target.id, animation: "smart", delay: 0 });
          } else {
            engine.dispatch({ type: "presentGo", id: target.id });
          }
        }
      } else if (e.key.toLowerCase() === "r") {
        engine.dispatch({ type: "presentStart" });
      } else if (e.key.toLowerCase() === "h") {
        engine.dispatch({ type: "togglePrototypeHotspots" });
      } else if (e.key.toLowerCase() === "i") {
        engine.dispatch({ type: "togglePrototypeLiveInputs" });
      } else if (e.key.toLowerCase() === "m") {
        engine.dispatch({ type: "togglePrototypeSound" });
      } else if (e.key.toLowerCase() === "f") {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [snap, curIndex, allFrames, engine, onExit]);

  // Dock mouse activity listener
  const showDockTemporarily = useCallback(() => {
    setDockVisible(true);
    if (dockTimeout.current) clearTimeout(dockTimeout.current);
    dockTimeout.current = window.setTimeout(() => setDockVisible(false), 3500);
  }, []);

  useEffect(() => {
    showDockTemporarily();
    return () => {
      if (dockTimeout.current) clearTimeout(dockTimeout.current);
    };
  }, [showDockTemporarily]);

  if (!presentNode) return null;

  return (
    <div
      className="prototype-player-layer"
      onMouseMove={showDockTemporarily}
      onClick={handleMissedClick}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "auto",
        overflow: "hidden",
        zIndex: 40,
      }}
    >
      {/* Click ripple animations */}
      {ripples.map((r) => (
        <div
          key={r.id}
          style={{
            position: "absolute",
            left: r.x - 24,
            top: r.y - 24,
            width: 48,
            height: 48,
            borderRadius: "50%",
            border: "2px solid #6366f1",
            background: "rgba(99, 102, 241, 0.2)",
            pointerEvents: "none",
            animation: "proto-ripple 0.5s ease-out forwards",
          }}
        />
      ))}

      {/* Device mockup: the shell is derived from the frame's own rect, so any
          frame size lands in a plausible device instead of a floating rectangle. */}
      {spec && <DeviceShell spec={spec} x={frameX} y={frameY} w={frameW} h={frameH} />}

      {/* Interactive Form Fields Overlay */}
      {liveInputsActive &&
        formFields.map((f) => {
          const sx = frameX + f.x * z;
          const sy = frameY + f.y * z;
          const sw = f.w * z;
          const sh = f.h * z;
          if (f.isToggle) {
            const isChecked = toggleValues[f.id] ?? false;
            return (
              <div
                key={f.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (soundActive) playTapSound(920, 0.04);
                  setToggleValues((prev) => ({ ...prev, [f.id]: !isChecked }));
                }}
                title="Click to toggle"
                style={{
                  position: "absolute",
                  left: sx,
                  top: sy,
                  width: sw,
                  height: sh,
                  cursor: "pointer",
                  zIndex: 44,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: isChecked ? "flex-end" : "flex-start",
                  padding: 2,
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    width: Math.min(sw / 2, sh - 4),
                    height: Math.min(sw / 2, sh - 4),
                    borderRadius: "50%",
                    background: isChecked ? "#6366f1" : "#94a3b8",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                    transition: "all 0.15s ease",
                  }}
                />
              </div>
            );
          }
          return (
            <input
              key={f.id}
              type="text"
              placeholder={f.text || "Type here…"}
              value={formValues[f.id] !== undefined ? formValues[f.id] : f.text || ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const val = e.target.value;
                setFormValues((prev) => ({ ...prev, [f.id]: val }));
                engine.dispatch({ type: "patch", id: f.id, patch: { text: val } });
              }}
              style={{
                position: "absolute",
                left: sx,
                top: sy,
                width: sw,
                height: sh,
                background: "transparent",
                border: "1px dashed rgba(13, 153, 255, 0.35)",
                borderRadius: 4,
                color: "inherit",
                fontSize: Math.max(10, 13 * z),
                fontFamily: "Inter, system-ui",
                padding: "0 8px",
                outline: "none",
                zIndex: 44,
                boxSizing: "border-box",
              }}
            />
          );
        })}

      {/* Interactive Hotspot Targets */}
      {hotspots.map((h) => {
        const sx = frameX + h.x * z;
        const sy = frameY + h.y * z;
        const sw = h.w * z;
        const sh = h.h * z;
        const isGlowing = hotspotPulse || (hotspotsActive && !snap.activeOverlay);
        return (
          <div
            key={h.id}
            onClick={(e) => {
              e.stopPropagation();
              triggerHotspot(h.interaction);
            }}
            title={`${h.name} (${h.interaction.action})`}
            style={{
              position: "absolute",
              left: sx,
              top: sy,
              width: sw,
              height: sh,
              cursor: "pointer",
              zIndex: 43,
              borderRadius: 6 * z,
              border: isGlowing ? "2px solid #6366f1" : "1px solid transparent",
              background: isGlowing ? "rgba(99, 102, 241, 0.16)" : "transparent",
              boxShadow: isGlowing ? "0 0 12px rgba(13, 153, 255, 0.45)" : "none",
              transition: "border 0.2s, background 0.2s, box-shadow 0.2s",
            }}
          />
        );
      })}

      {/* Floating Glass Presentation Control Dock */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: 24,
          left: "50%",
          transform: `translateX(-50%) translateY(${dockVisible ? "0px" : "80px"})`,
          transition: "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s",
          opacity: dockVisible ? 1 : 0,
          background: "rgba(24, 24, 27, 0.85)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: 24,
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
          padding: "6px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          zIndex: 50,
          color: "#fff",
          fontSize: 12,
          fontFamily: "Inter, system-ui",
          userSelect: "none",
        }}
      >
        {/* Flow & Frame Selector */}
        <select
          value={snap.presentFrame}
          onChange={(e) => {
            const dest = e.target.value;
            if (onInteraction) {
              onInteraction({ trigger: "onClick", action: "navigate", destination: dest, animation: "smart", delay: 0 });
            } else {
              engine.dispatch({ type: "presentGo", id: dest });
            }
          }}
          style={{
            background: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            borderRadius: 14,
            color: "#fff",
            padding: "4px 10px",
            fontSize: 11,
            outline: "none",
            cursor: "pointer",
            maxWidth: 140,
            textOverflow: "ellipsis",
          }}
        >
          {allFrames.map((f, i) => (
            <option key={f.id} value={f.id} style={{ background: "#18181b", color: "#fff" }}>
              {i + 1}. {f.name}
            </option>
          ))}
        </select>

        {/* Previous Frame */}
        <button
          onClick={() => {
            if (curIndex > 0) engine.dispatch({ type: "presentGo", id: allFrames[curIndex - 1].id });
          }}
          disabled={curIndex <= 0}
          title="Previous frame (←)"
          style={{
            background: "transparent",
            border: 0,
            color: curIndex <= 0 ? "rgba(255,255,255,0.3)" : "#fff",
            cursor: curIndex <= 0 ? "default" : "pointer",
            padding: "4px 6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="arrow-left" size={14} />
        </button>

        {/* Frame Pager Index */}
        <span style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.7)", minWidth: 40, textAlign: "center" }}>
          {curIndex >= 0 ? `${curIndex + 1} / ${allFrames.length}` : "—"}
        </span>

        {/* Next Frame */}
        <button
          onClick={() => {
            if (curIndex < allFrames.length - 1) engine.dispatch({ type: "presentGo", id: allFrames[curIndex + 1].id });
          }}
          disabled={curIndex >= allFrames.length - 1}
          title="Next frame (→ / Space)"
          style={{
            background: "transparent",
            border: 0,
            color: curIndex >= allFrames.length - 1 ? "rgba(255,255,255,0.3)" : "#fff",
            cursor: curIndex >= allFrames.length - 1 ? "default" : "pointer",
            padding: "4px 6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="arrow-right" size={14} />
        </button>

        <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

        {/* Restart Flow */}
        <button
          onClick={() => engine.dispatch({ type: "presentStart" })}
          title="Restart flow (R)"
          style={{
            background: "transparent",
            border: 0,
            color: "#fff",
            cursor: "pointer",
            padding: "4px 6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
          }}
        >
          <Icon name="history" size={rowIconSize()} />
          <span>Restart</span>
        </button>

        {/* Hotspots Toggle */}
        <button
          onClick={() => engine.dispatch({ type: "togglePrototypeHotspots" })}
          title="Toggle hotspot hints (H)"
          style={{
            background: hotspotsActive ? "rgba(13, 153, 255, 0.25)" : "transparent",
            border: 0,
            color: hotspotsActive ? "#38bdf8" : "rgba(255,255,255,0.7)",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
          }}
        >
          <Icon name="pointer" size={rowIconSize()} />
          <span>Hotspots</span>
        </button>

        {/* Device Preset Switcher */}
        <select
          value={device}
          onChange={(e) => engine.dispatch({ type: "setPrototypeDevice", device: e.target.value as ProtoDevice })}
          title="Device Mockup Frame"
          style={{
            background: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            borderRadius: 14,
            color: "#fff",
            padding: "4px 8px",
            fontSize: 11,
            outline: "none",
            cursor: "pointer",
          }}
        >
          <option value="none" style={{ background: "#18181b" }}>No device</option>
          {DEVICE_GROUPS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((d) => (
                <option key={d.id} value={d.id} style={{ background: "#18181b" }}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Scale Switcher */}
        <button
          onClick={() => {
            const next = scaleMode === "fit" ? "100%" : "fit";
            engine.dispatch({ type: "setPrototypeScale", scale: next });
            if (next === "100%") {
              engine.dispatch({ type: "setZoom", zoom: 1 });
            } else if (presentNode) {
              const vw = window.innerWidth;
              const vh = window.innerHeight;
              const nextZ = Math.min(1.0, Math.max(0.2, Math.min((vw - 160) / presentNode.w, (vh - 160) / presentNode.h)));
              engine.dispatch({ type: "setZoom", zoom: nextZ });
              engine.dispatch({
                type: "setPan",
                x: Math.round((vw - presentNode.w * nextZ) / 2 - (wp ? wp.x * nextZ : 0)),
                y: Math.round((vh - presentNode.h * nextZ) / 2 - (wp ? wp.y * nextZ : 0)),
              });
            }
          }}
          title={`Scale mode: ${scaleMode} (click to toggle)`}
          style={{
            background: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            borderRadius: 14,
            color: "#fff",
            padding: "4px 8px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {scaleMode === "fit" ? "Fit" : "100%"}
        </button>

        {/* Live Form Inputs Toggle */}
        <button
          onClick={() => engine.dispatch({ type: "togglePrototypeLiveInputs" })}
          title="Toggle live editable inputs (I)"
          style={{
            background: liveInputsActive ? "rgba(16, 185, 129, 0.25)" : "transparent",
            border: 0,
            color: liveInputsActive ? "#34d399" : "rgba(255,255,255,0.7)",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
          }}
        >
          <Icon name="type" size={rowIconSize()} />
          <span>Live Inputs</span>
        </button>

        {/* Sound Toggle */}
        <button
          onClick={() => engine.dispatch({ type: "togglePrototypeSound" })}
          title="Toggle tactile sound feedback (M)"
          style={{
            background: soundActive ? "rgba(255, 255, 255, 0.1)" : "transparent",
            border: 0,
            color: soundActive ? "#fff" : "rgba(255,255,255,0.4)",
            cursor: "pointer",
            padding: "4px 6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name={soundActive ? "volume" : "volume-x"} size={rowIconSize()} />
        </button>

        {/* Fullscreen Toggle */}
        <button
          onClick={() => {
            if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
            else document.exitFullscreen().catch(() => {});
          }}
          title="Fullscreen (F)"
          style={{
            background: "transparent",
            border: 0,
            color: "#fff",
            cursor: "pointer",
            padding: "4px 6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="fullscreen" size={rowIconSize()} />
        </button>

        {/* Exit Presentation */}
        <button
          onClick={onExit}
          title="Exit presentation (Esc)"
          style={{
            background: "rgba(239, 68, 68, 0.25)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            color: "#fca5a5",
            cursor: "pointer",
            padding: "4px 10px",
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
          }}
        >
          <Icon name="close" size={12} />
          <span>Exit</span>
        </button>
      </div>

      <style>{`
        @keyframes proto-ripple {
          0% { transform: scale(0.3); opacity: 1; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
