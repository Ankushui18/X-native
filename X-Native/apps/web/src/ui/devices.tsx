import type { CSSProperties, ReactNode } from "react";
import type { ProtoDevice } from "../engine/types";

/**
 * Device frames for the prototype preview and presentation view.
 *
 * A device mockup is geometry, not decoration: the shell is derived from the
 * frame being presented, so any frame size lands in a plausible phone, tablet
 * or laptop instead of a black rectangle with a white rounded square pasted on
 * it. Everything here is drawn with divs — no bitmaps to license, and it stays
 * sharp at any presentation scale.
 */

export interface DeviceSpec {
  id: ProtoDevice;
  label: string;
  group: "Phone" | "Tablet" | "Laptop" | "Watch" | "Desktop";
  /** Reference screen size, in the device's own points. Used for the panel
   *  preview and to derive proportions. */
  screen: [number, number];
  /** Shell corner radius as a fraction of the shorter shell edge. */
  radiusRatio: number;
  /** Bezel thickness as a fraction of the shorter shell edge. */
  bezelRatio: number;
  /** Extra space at the bottom of the shell (chin / keyboard deck). */
  chinRatio?: number;
  /** Space above the shell: laptop lid hinge, watch crown side, etc. */
  crownRatio?: number;
  cutout?: "island" | "punch" | "notch" | "none";
  homeIndicator?: boolean;
  statusBar?: "ios" | "android" | "none";
  /** Colour of the shell, top→bottom, for a metal sheen. */
  shell?: [string, string, string];
  /** Hardware buttons: side and length as fractions of the shell height. */
  buttons?: { side: "left" | "right"; from: number; to: number; label?: string }[];
  laptop?: boolean;
}

export const DEVICES: DeviceSpec[] = [
  {
    id: "iphone-16-pro",
    label: "iPhone 16 Pro",
    group: "Phone",
    screen: [402, 874],
    radiusRatio: 0.135,
    bezelRatio: 0.026,
    cutout: "island",
    homeIndicator: true,
    statusBar: "ios",
    shell: ["#6d6f74", "#33353a", "#5e6066"],
    buttons: [
      { side: "left", from: 0.16, to: 0.235, label: "Action" },
      { side: "left", from: 0.29, to: 0.37, label: "Volume up" },
      { side: "left", from: 0.385, to: 0.465, label: "Volume down" },
      { side: "right", from: 0.3, to: 0.4, label: "Power" },
      { side: "right", from: 0.44, to: 0.5, label: "Camera" },
    ],
  },
  {
    id: "iphone-se",
    label: "iPhone SE",
    group: "Phone",
    screen: [375, 667],
    radiusRatio: 0.11,
    bezelRatio: 0.028,
    chinRatio: 0.075,
    cutout: "none",
    statusBar: "ios",
    shell: ["#8e9096", "#3a3c41", "#7c7e84"],
  },
  {
    id: "pixel-9",
    label: "Google Pixel 9",
    group: "Phone",
    screen: [411, 891],
    radiusRatio: 0.105,
    bezelRatio: 0.022,
    cutout: "punch",
    homeIndicator: true,
    statusBar: "android",
    shell: ["#5c5f66", "#26282c", "#4a4d53"],
    buttons: [
      { side: "right", from: 0.24, to: 0.31, label: "Power" },
      { side: "right", from: 0.33, to: 0.43, label: "Volume" },
    ],
  },
  {
    id: "ipad-pro",
    label: 'iPad Pro 13"',
    group: "Tablet",
    screen: [1032, 1372],
    radiusRatio: 0.045,
    bezelRatio: 0.032,
    cutout: "none",
    homeIndicator: true,
    statusBar: "ios",
    shell: ["#7a7c82", "#3c3e43", "#6b6d73"],
  },
  {
    id: "macbook-pro",
    label: 'MacBook Pro 14"',
    group: "Laptop",
    screen: [1512, 982],
    radiusRatio: 0.03,
    bezelRatio: 0.022,
    chinRatio: 0.14,
    cutout: "notch",
    statusBar: "none",
    laptop: true,
    shell: ["#8d9096", "#4a4d53", "#7a7d83"],
  },
  {
    id: "desktop",
    label: "Display",
    group: "Desktop",
    screen: [1440, 900],
    radiusRatio: 0.014,
    bezelRatio: 0.026,
    chinRatio: 0.1,
    cutout: "none",
    statusBar: "none",
    shell: ["#2f3237", "#17181b", "#26282c"],
  },
  {
    id: "apple-watch",
    label: "Apple Watch",
    group: "Watch",
    screen: [198, 242],
    radiusRatio: 0.3,
    bezelRatio: 0.055,
    crownRatio: 0.0,
    cutout: "none",
    statusBar: "none",
    shell: ["#7e8188", "#3a3d42", "#6a6d73"],
    buttons: [{ side: "right", from: 0.26, to: 0.4, label: "Crown" }],
  },
  {
    id: "none",
    label: "None",
    group: "Phone",
    screen: [390, 844],
    radiusRatio: 0,
    bezelRatio: 0,
    cutout: "none",
    statusBar: "none",
  },
];

export function deviceFor(id: ProtoDevice | undefined | null): DeviceSpec | null {
  if (!id || id === "none") return null;
  return DEVICES.find((d) => d.id === id) ?? null;
}

const STATUS_TIME = "9:41";

function gwPad(scale: number) {
  return 13 * scale;
}

function StatusBar({ ios, scale, band }: { ios: boolean; scale: number; band: number }) {
  const h = band;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: h,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${Math.max(10, gwPad(scale))}px 0 ${Math.max(10, gwPad(scale))}px`,
        fontSize: Math.max(8, 11 * scale),
        fontWeight: 600,
        // iOS inverts the status bar against the design underneath; `difference`
        // gives us that for free without reading the frame's pixels.
        color: "#fff",
        pointerEvents: "none",
        fontFamily: "Inter, system-ui, sans-serif",
        zIndex: 3,
      }}
    >
      <span style={{ letterSpacing: 0.2 }}>{ios ? STATUS_TIME : "9:41"}</span>
      <span style={{ display: "flex", alignItems: "center", gap: Math.max(2, 4 * scale) }}>
        <svg width={Math.max(12, 17 * scale)} height={Math.max(7, 11 * scale)} viewBox="0 0 17 11" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={i * 4.2} y={7 - i * 2.2} width="3" height={4 + i * 2.2} rx="1" fill="currentColor" />
          ))}
        </svg>
        <svg width={Math.max(12, 16 * scale)} height={Math.max(9, 12 * scale)} viewBox="0 0 16 12" aria-hidden>
          <path
            d="M8 10.4 5.7 8.1a3.3 3.3 0 014.6 0L8 10.4Zm-4-4.2a6.6 6.6 0 018 0M1.6 3.6a10 10 0 0112.8 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        <svg width={Math.max(20, 26 * scale)} height={Math.max(10, 12 * scale)} viewBox="0 0 26 12" aria-hidden>
          <rect x="0.6" y="0.6" width="21" height="10.8" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.5" />
          <rect x="2.2" y="2.2" width="15" height="7.6" rx="1.8" fill="currentColor" />
          <path d="M23.4 4.2v3.6a2 2 0 000-3.6Z" fill="currentColor" fillOpacity="0.5" />
        </svg>
      </span>
    </div>
  );
}

/**
 * How much glass the device adds around the design. The bands scale with the
 * frame itself, so the whole mockup stays proportional at any presentation
 * zoom — and the status bar gets a band of its own instead of sitting on top of
 * the design's headline.
 */
export function devicePadding(spec: DeviceSpec | null, w: number, h: number) {
  const min = Math.min(w, h);
  const bez = spec ? Math.max(3, min * spec.bezelRatio) : 0;
  const top = spec?.statusBar && spec.statusBar !== "none" ? Math.max(bez, h * 0.046) : bez;
  const bottom = spec?.homeIndicator ? Math.max(bez, h * 0.032) : bez;
  const chin = spec ? Math.max(0, (spec.chinRatio ?? 0) * w) : 0;
  return { bez, top, bottom, chin, rScreen: spec ? Math.max(2, Math.max(bez + 2, min * spec.radiusRatio) - bez * 0.85) : 0 };
}

/** Fit box for a presented frame in design units (pre-zoom), shell included. */
export function deviceBox(spec: DeviceSpec | null, w: number, h: number) {
  const pad = devicePadding(spec, w, h);
  return {
    /** shell width, bezel included */
    w: w + pad.bez * 2,
    /** design + safe-area bands, bezel excluded — what we centre vertically */
    glassH: h + pad.top + pad.bottom + pad.chin,
    /** full height including the bezel ring */
    h: h + pad.top + pad.bottom + pad.chin + pad.bez * 2,
    bezShift: pad.bez,
    pad,
  };
}

/**
 * The shell, positioned in the same coordinate space as the presented frame.
 * `x/y/w/h` describe the *screen* (the design frame); the shell grows outward
 * from it, so the design always lines up with the device glass.
 */
export function DeviceShell({
  spec,
  x,
  y,
  w,
  h,
  showChrome = true,
}: {
  spec: DeviceSpec;
  x: number;
  y: number;
  w: number;
  h: number;
  showChrome?: boolean;
}) {
  if (!spec) return null;
  const min = Math.min(w, h);
  const { bez, top, bottom, chin } = devicePadding(spec, w, h);
  const rShell = Math.max(bez + 2, min * spec.radiusRatio);
  const [c1, c2, c3] = spec.shell ?? ["#55585e", "#26282c", "#43464b"];
  // The glass: the design plus its status-bar and home-indicator bands.
  const gx = x - bez;
  const gy = y - top;
  const gw = w + bez * 2;
  const gh = h + top + bottom;
  const ox = gx;
  const oy = gy;
  const ow = gw;
  const oh = gh + chin;

  const parts: ReactNode[] = [];

  // The device's own safe area, above and below the design. Only the bands are
  // painted: the design itself stays live on the canvas underneath, so an
  // opaque "glass" plate over the whole screen would hide it.
  const bandStyle = (top0: number, h0: number, roundTop: boolean): CSSProperties => ({
    position: "absolute",
    left: gx,
    top: top0,
    width: gw,
    height: h0,
    background: "#050607",
    borderRadius: roundTop
      ? `${rShell}px ${rShell}px 0 0`
      : `0 0 ${rShell}px ${rShell}px`,
    pointerEvents: "none",
  });
  if (top > bez) parts.push(<div key="band-top" style={bandStyle(gy, top - bez * 0.1, true)} />);
  if (bottom > bez)
    parts.push(<div key="band-bot" style={bandStyle(y + h + bez * 0.1, bottom - bez * 0.1, false)} />);

  // Shell ring from stacked spread shadows: solid metal, light hairline, dark
  // outer lip, plus a drop shadow. Spread shadows keep the centre click-through,
  // which a gradient border + mask did not.
  const ring = [
    `0 0 0 ${bez}px ${c2}`,
    `0 0 0 ${bez + Math.max(1, bez * 0.18)}px ${c1}`,
    `0 0 0 ${bez + Math.max(2, bez * 0.34)}px ${c3}`,
    `0 ${Math.max(10, min * 0.1)}px ${Math.max(28, min * 0.4)}px rgba(0,0,0,0.5)`,
  ].join(", ");
  parts.push(
    <div
      key="shell"
      style={{
        position: "absolute",
        left: gx,
        top: gy,
        width: gw,
        height: gh,
        borderRadius: rShell,
        boxShadow: ring,
        pointerEvents: "none",
        zIndex: 2,
      }}
    />,
  );

  if (chin > 0) {
    parts.push(
      <div
        key="chin"
        style={{
          position: "absolute",
          left: ox,
          top: oy + oh - chin,
          width: ow,
          height: chin,
          background: `linear-gradient(180deg, ${c2}, ${c3})`,
          borderRadius: `0 0 ${Math.max(4, rShell * 0.6)}px ${Math.max(4, rShell * 0.6)}px`,
          boxShadow: `0 ${Math.max(6, min * 0.05)}px ${Math.max(18, min * 0.24)}px rgba(0,0,0,0.42)`,
          pointerEvents: "none",
        }}
      />,
    );
  }

  const scale = Math.max(0.5, Math.min(2.2, w / spec.screen[0]));

  if (spec.cutout === "island") {
    const iw = Math.max(60, 0.29 * gw);
    const ih = Math.max(15, gw * 0.075);
    parts.push(
      <div
        key="island"
        style={{
          position: "absolute",
          left: gx + gw / 2 - iw / 2,
          top: gy + Math.max(4, top * 0.22),
          width: iw,
          height: ih,
          borderRadius: ih,
          background: "#000",
          pointerEvents: "none",
          zIndex: 5,
        }}
      />,
    );
  } else if (spec.cutout === "punch") {
    const d = Math.max(8, 0.05 * gw);
    parts.push(
      <div
        key="punch"
        style={{
          position: "absolute",
          left: gx + gw / 2 - d / 2,
          top: gy + Math.max(4, top * 0.18),
          width: d,
          height: d,
          borderRadius: "50%",
          background: "#05070a",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.12)",
          pointerEvents: "none",
          zIndex: 5,
        }}
      />,
    );
  } else if (spec.cutout === "notch") {
    const nw = Math.max(64, 0.17 * gw);
    const nh = Math.max(10, top * 0.55);
    parts.push(
      <div
        key="notch"
        style={{
          position: "absolute",
          left: gx + gw / 2 - nw / 2,
          top: gy,
          width: nw,
          height: nh,
          background: "#101114",
          borderBottomLeftRadius: nh * 0.7,
          borderBottomRightRadius: nh * 0.7,
          pointerEvents: "none",
          zIndex: 5,
        }}
      />,
    );
  }

  if (spec.homeIndicator) {
    const hw = Math.max(60, 0.32 * gw);
    parts.push(
      <div
        key="home"
        style={{
          position: "absolute",
          left: gx + gw / 2 - hw / 2,
          top: y + h + bottom * 0.34,
          width: hw,
          height: Math.max(3, bottom * 0.2),
          borderRadius: 99,
          background: "#fff",
          pointerEvents: "none",
          zIndex: 5,
        }}
      />,
    );
  }

  if (spec.statusBar && spec.statusBar !== "none") {
    parts.push(
      <div
        key="sb"
        style={{
          position: "absolute",
          left: gx,
          top: gy,
          width: gw,
          height: top,
          pointerEvents: "none",
          zIndex: 4,
        }}
      >
        <StatusBar ios={spec.statusBar === "ios"} scale={scale} band={top} />
      </div>,
    );
  }

  for (const [i, b] of (spec.buttons ?? []).entries()) {
    const bh = Math.max(6, (b.to - b.from) * oh);
    const bw = Math.max(2, bez * 0.8);
    parts.push(
      <div
        key={`btn-${i}`}
        title={b.label}
        style={{
          position: "absolute",
          [b.side === "left" ? "left" : "right"]: 0,
          top: oy + b.from * oh,
          width: bw,
          height: bh,
          borderRadius: bw,
          background: `linear-gradient(90deg, ${c1}, ${c3})`,
          transform: b.side === "left" ? "translateX(-100%)" : "translateX(100%)",
          pointerEvents: "none",
        } as CSSProperties}
      />,
    );
  }

  if (spec.laptop) {
    const dw = ow * 1.16;
    const dh = Math.max(8, bez * 2.4);
    parts.push(
      <div
        key="deck"
        style={{
          position: "absolute",
          left: ox - (dw - ow) / 2,
          top: oy + oh - 1,
          width: dw,
          height: dh,
          borderRadius: `0 0 ${dh * 0.7}px ${dh * 0.7}px`,
          background: `linear-gradient(180deg, ${c1}, ${c2})`,
          boxShadow: `0 ${dh * 0.6}px ${dh * 1.6}px rgba(0,0,0,0.4)`,
          pointerEvents: "none",
        }}
      />,
    );
    parts.push(
      <div
        key="deck-notch"
        style={{
          position: "absolute",
          left: gx + gw / 2 - dw * 0.09,
          top: oy + oh - 1,
          width: dw * 0.18,
          height: Math.max(3, dh * 0.42),
          borderRadius: `0 0 ${dh}px ${dh}px`,
          background: "rgba(0,0,0,0.28)",
          pointerEvents: "none",
        }}
      />,
    );
  }

  if (!showChrome) return null;
  return <>{parts}</>;
}

/** Small inline mockup for the Prototype panel: the frame's own fill inside a
 *  device shell scaled to fit the preview box. */
export function DevicePreview({
  spec,
  fill,
  radius,
  maxW = 216,
  maxH = 116,
}: {
  spec: DeviceSpec | null;
  fill: string;
  radius: number;
  maxW?: number;
  maxH?: number;
}) {
  const ratio = spec ? spec.screen[0] / spec.screen[1] : 16 / 10;
  let sw = maxW;
  let sh = sw / ratio;
  if (sh > maxH) {
    sh = maxH;
    sw = sh * ratio;
  }
  const bez = spec ? Math.max(2, Math.min(sw, sh) * spec.bezelRatio * 2.1) : 1;
  const rOut = spec ? Math.max(bez + 1.5, Math.min(sw, sh) * spec.radiusRatio) : 4;
  const rIn = Math.max(1.5, rOut - bez * 0.7);
  const [c1, c2] = spec?.shell ?? ["#55585e", "#26282c"];
  return (
    <div
      style={{
        position: "relative",
        width: sw + bez * 2,
        height: sh + bez * 2,
        margin: "0 auto",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: rOut,
          background: `linear-gradient(160deg, ${c1}, ${c2})`,
          boxShadow: "0 6px 16px rgba(0,0,0,0.28)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: bez,
          top: bez,
          width: sw,
          height: sh,
          borderRadius: rIn,
          background: fill || "#fff",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: Math.max(6, sh * 0.07),
            background: "linear-gradient(#ffffff22, transparent)",
          }}
        />
        {spec?.cutout === "island" && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: Math.max(1.5, sh * 0.022),
              transform: "translateX(-50%)",
              width: sw * 0.26,
              height: Math.max(2.5, sh * 0.03),
              borderRadius: 99,
              background: "#000",
            }}
          />
        )}
        {spec?.cutout === "punch" && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: Math.max(1.5, sh * 0.022),
              transform: "translateX(-50%)",
              width: Math.max(2.5, sw * 0.035),
              height: Math.max(2.5, sw * 0.035),
              borderRadius: "50%",
              background: "#000",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            left: 6,
            right: 6,
            bottom: Math.max(3, sh * 0.04),
            height: 2,
            borderRadius: 2,
            background: "rgba(0,0,0,0.18)",
            opacity: spec?.homeIndicator ? 1 : 0,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: radius ? Math.max(0, Math.min(radius, sw / 2, sh / 2)) : 0,
            borderRadius: Math.max(0, radius - 2),
            border: "1px dashed rgba(0,0,0,0.12)",
          }}
        />
      </div>
    </div>
  );
}

/** Device picker groups, in the order Figma lists them. */
export const DEVICE_GROUPS: { group: DeviceSpec["group"]; items: DeviceSpec[] }[] = [
  { group: "Phone", items: DEVICES.filter((d) => d.group === "Phone" && d.id !== "none") },
  { group: "Tablet", items: DEVICES.filter((d) => d.group === "Tablet") },
  { group: "Laptop", items: DEVICES.filter((d) => d.group === "Laptop") },
  { group: "Desktop", items: DEVICES.filter((d) => d.group === "Desktop") },
  { group: "Watch", items: DEVICES.filter((d) => d.group === "Watch") },
];
