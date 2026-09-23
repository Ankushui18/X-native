import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type { Engine, Interaction, ProtoDevice, Snapshot, XNode } from "../engine/types";
import { find, worldPos } from "../engine/memory";
import { Icon } from "./icons";

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
}: {
  engine: Engine;
  snap: Snapshot;
  onExit: () => void;
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
        if (curIndex > 0) engine.dispatch({ type: "presentGo", id: allFrames[curIndex - 1].id });
      } else if (e.key === "ArrowRight" || e.key === " ") {
        if (curIndex < allFrames.length - 1) engine.dispatch({ type: "presentGo", id: allFrames[curIndex + 1].id });
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
            border: "2px solid #0d99ff",
            background: "rgba(13, 153, 255, 0.2)",
            pointerEvents: "none",
            animation: "proto-ripple 0.5s ease-out forwards",
          }}
        />
      ))}

      {/* Device Bezel Framing */}
      {device === "iphone-16-pro" && (
        <div
          style={{
            position: "absolute",
            left: frameX - 16 * z,
            top: frameY - 16 * z,
            width: frameW + 32 * z,
            height: frameH + 32 * z,
            borderRadius: 54 * z,
            boxShadow: `0 0 0 ${4 * z}px #2e2f33, 0 0 0 ${6 * z}px #4b4d52, 0 30px 60px rgba(0,0,0,0.5)`,
            pointerEvents: "none",
            zIndex: 42,
          }}
        >
          {/* Dynamic Island */}
          <div
            style={{
              position: "absolute",
              top: 24 * z,
              left: "50%",
              transform: "translateX(-50%)",
              width: 120 * z,
              height: 35 * z,
              background: "#000",
              borderRadius: 20 * z,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: `0 ${12 * z}px`,
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            <div
              style={{
                width: 11 * z,
                height: 11 * z,
                borderRadius: "50%",
                background: "#0f172a",
                border: "1px solid rgba(255,255,255,0.15)",
              }}
            />
            <div
              style={{
                width: 10 * z,
                height: 10 * z,
                borderRadius: "50%",
                background: "#0284c7",
                opacity: 0.8,
              }}
            />
          </div>
          {/* iOS Home Indicator */}
          <div
            style={{
              position: "absolute",
              bottom: 22 * z,
              left: "50%",
              transform: "translateX(-50%)",
              width: 134 * z,
              height: 5 * z,
              background: "#fff",
              opacity: 0.7,
              borderRadius: 3 * z,
            }}
          />
        </div>
      )}

      {device === "pixel-9" && (
        <div
          style={{
            position: "absolute",
            left: frameX - 12 * z,
            top: frameY - 12 * z,
            width: frameW + 24 * z,
            height: frameH + 24 * z,
            borderRadius: 44 * z,
            boxShadow: `0 0 0 ${4 * z}px #1f2023, 0 24px 50px rgba(0,0,0,0.45)`,
            pointerEvents: "none",
            zIndex: 42,
          }}
        >
          {/* Camera hole */}
          <div
            style={{
              position: "absolute",
              top: 20 * z,
              left: "50%",
              transform: "translateX(-50%)",
              width: 13 * z,
              height: 13 * z,
              borderRadius: "50%",
              background: "#05070a",
              border: "1px solid rgba(255,255,255,0.2)",
            }}
          />
        </div>
      )}

      {device === "macbook-pro" && (
        <div
          style={{
            position: "absolute",
            left: frameX - 18 * z,
            top: frameY - 24 * z,
            width: frameW + 36 * z,
            height: frameH + 34 * z,
            borderRadius: 14 * z,
            boxShadow: `0 0 0 ${4 * z}px #1c1d20, 0 0 0 ${6 * z}px #383a3f, 0 40px 80px rgba(0,0,0,0.6)`,
            pointerEvents: "none",
            zIndex: 42,
          }}
        >
          {/* Display Notch */}
          <div
            style={{
              position: "absolute",
              top: 24 * z,
              left: "50%",
              transform: "translateX(-50%)",
              width: 80 * z,
              height: 16 * z,
              background: "#000",
              borderBottomLeftRadius: 8 * z,
              borderBottomRightRadius: 8 * z,
            }}
          />
        </div>
      )}

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
                    background: isChecked ? "#0d99ff" : "#94a3b8",
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
              border: isGlowing ? "2px solid #0d99ff" : "1px solid transparent",
              background: isGlowing ? "rgba(13, 153, 255, 0.16)" : "transparent",
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
          onChange={(e) => engine.dispatch({ type: "presentGo", id: e.target.value })}
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
          <Icon name="history" size={13} />
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
          <Icon name="pointer" size={13} />
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
          <option value="none" style={{ background: "#18181b" }}>No Device</option>
          <option value="iphone-16-pro" style={{ background: "#18181b" }}>iPhone 16 Pro</option>
          <option value="pixel-9" style={{ background: "#18181b" }}>Google Pixel 9</option>
          <option value="macbook-pro" style={{ background: "#18181b" }}>MacBook Pro 16"</option>
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
          title="Toggle live editable inputs (I) - Better than Figma!"
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
          <Icon name="type" size={13} />
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
          <Icon name={soundActive ? "volume" : "volume-x"} size={13} />
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
          <Icon name="fullscreen" size={13} />
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
