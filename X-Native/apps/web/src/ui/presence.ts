/**
 * Multiplayer presence: live cursors and selections for every tab of this
 * app open in the same browser. The transport is BroadcastChannel — real
 * cross-window traffic with no server, no polling loop and no dependency; a
 * tab is a collaborator, and closing it (pagehide) says goodbye so its cursor
 * disappears the way a leaving collaborator's does.
 *
 * Identity is a session-scoped constellation name and hue (Nova, Vega, …):
 * enough to tell cursors apart on canvas and in the avatar cluster, without
 * pretending to be accounts. The hue is generated from the session id, so two
 * tabs never fight over the same colour.
 */
import { useEffect, useSyncExternalStore } from "react";

export type Peer = {
  id: string;
  name: string;
  /** 0–360; the peer's identity colour on canvas and in the avatar cluster. */
  hue: number;
  /** Pointer position in WORLD coordinates, so every tab's pan/zoom agrees. */
  x: number;
  y: number;
  /** Node ids this peer has selected, for remote selection outlines. */
  sel: string[];
  /** Performance timestamp of the last packet; peers go quiet past TTL. */
  last: number;
};

export type PresenceMe = { id: string; name: string; hue: number };

const CHANNEL = "x-native-presence";
const TTL_MS = 3000;
const HEARTBEAT_MS = 1000;
const MOVE_MS = 40;

const NAMES = [
  "Nova",
  "Vega",
  "Lyra",
  "Orion",
  "Rigel",
  "Altair",
  "Sirius",
  "Pulsar",
  "Quasar",
  "Comet",
  "Aurora",
  "Zenith",
  "Halley",
  "Cygnus",
  "Draco",
  "Aquila",
];

const meId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `peer-${Math.random().toString(36).slice(2)}`;

const me: PresenceMe = {
  id: meId,
  name: NAMES[Math.floor(Math.random() * NAMES.length)],
  hue: Math.floor(Math.random() * 360),
};

let channel: BroadcastChannel | null = null;
const peers = new Map<string, Peer>();
/** Stable array identity for useSyncExternalStore; replaced on every change. */
let peersSnapshot: Peer[] = [];
const listeners = new Set<() => void>();

function emit() {
  peersSnapshot = [...peers.values()];
  for (const l of listeners) l();
}

type Packet =
  | { type: "hello"; id: string; name: string; hue: number }
  | { type: "move"; id: string; x: number; y: number; sel: string[] }
  | { type: "bye"; id: string };

function handle(p: Packet) {
  if (p.type === "bye") {
    if (peers.delete(p.id)) emit();
    return;
  }
  if (p.id === me.id) return;
  const now = performance.now();
  if (p.type === "hello") {
    const prev = peers.get(p.id);
    peers.set(p.id, {
      id: p.id,
      name: p.name,
      hue: p.hue,
      x: prev?.x ?? 0,
      y: prev?.y ?? 0,
      sel: prev?.sel ?? [],
      last: now,
    });
  } else {
    const prev = peers.get(p.id);
    peers.set(p.id, {
      id: p.id,
      name: prev?.name ?? "Guest",
      hue: prev?.hue ?? 0,
      x: p.x,
      y: p.y,
      sel: p.sel,
      last: now,
    });
  }
  emit();
}

let started = false;
let heartbeat: ReturnType<typeof setInterval> | 0 = 0;

/**
 * Test engines (jsdom's UA) and bare engines must not join: a live channel or
 * heartbeat is an open handle that keeps the suite's event loop alive forever.
 * Real browsers join; every handle below is unref'd as a second line of
 * defence for node-flavoured engines that do run.
 */
function engineAllowsPresence(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined" &&
    !(typeof navigator !== "undefined" && (navigator.userAgent || "").includes("jsdom"))
  );
}

/** Join the room. Idempotent; a no-op where presence cannot safely run. */
export function startPresence() {
  if (started) return;
  if (!engineAllowsPresence()) return;
  started = true;
  channel = new BroadcastChannel(CHANNEL);
  (channel as unknown as { unref?: () => void }).unref?.();
  channel.onmessage = (e: MessageEvent<Packet>) => handle(e.data);
  send({ type: "hello", id: me.id, name: me.name, hue: me.hue });
  heartbeat = setInterval(() => {
    send({ type: "hello", id: me.id, name: me.name, hue: me.hue });
    // Quiet peers have closed their tab without a pagehide (crash, kill -9).
    const now = performance.now();
    let changed = false;
    for (const [id, p] of peers) {
      if (now - p.last > TTL_MS) {
        peers.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
  }, HEARTBEAT_MS);
  (heartbeat as unknown as { unref?: () => void }).unref?.();
  window.addEventListener("pagehide", () => {
    send({ type: "bye", id: me.id });
    channel?.close();
    channel = null;
    clearInterval(heartbeat);
    heartbeat = 0;
    started = false;
  });
}

function send(p: Packet) {
  try {
    channel?.postMessage(p);
  } catch {
    /* channel closed mid-send: the next startPresence() re-joins */
  }
}

let lastMove = 0;
let pending: { x: number; y: number; sel: string[] } | null = null;
let flushTimer = 0;
/** Our last broadcast position, so selection-only sends keep the cursor still. */
let myPos = { x: 0, y: 0 };

/** Broadcast this tab's pointer (world coords) and selection, coalesced to MOVE_MS. */
export function presenceMove(x: number, y: number, sel: readonly string[] = []) {
  if (!channel) return;
  myPos = { x, y };
  pending = { x, y, sel: [...sel] };
  const now = performance.now();
  const wait = Math.max(0, MOVE_MS - (now - lastMove));
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    lastMove = performance.now();
    if (pending) send({ type: "move", id: me.id, x: pending.x, y: pending.y, sel: pending.sel });
    pending = null;
  }, wait);
}

/** Selection-only broadcast (right after a click, before the pointer moves). */
export function presenceSelect(sel: readonly string[]) {
  if (!channel) return;
  send({ type: "move", id: me.id, x: myPos.x, y: myPos.y, sel: [...sel] });
}

export function getPeers(): Peer[] {
  return peersSnapshot;
}

export function subscribePeers(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function presenceMe(): PresenceMe {
  return me;
}

/** The collaborators of this document: everyone here plus the local user. */
export function usePresence(): { me: PresenceMe; peers: Peer[] } {
  useEffect(() => {
    startPresence();
  }, []);
  const list = useSyncExternalStore(subscribePeers, getPeers, getPeers);
  return { me, peers: list };
}
