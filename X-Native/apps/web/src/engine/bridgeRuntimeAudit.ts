/**
 * Opt-in, bounded runtime evidence from the application's actual WASM call sites.
 * No document contents, import bytes, node IDs, paths, or user text are logged.
 * This is a diagnostic, not a replacement for native/TS equivalence testing.
 */

type Bridge = "imports" | "geometry" | "session";
type Decision = {
  bridge: Bridge;
  operation: string;
  result: "rust" | "ts" | "none";
  guard: "passed" | "blocked" | "bypassed" | "not-run";
  reason: string;
  candidate: boolean;
};
type FunctionCount = { calls: number; succeeded: number; failed: number; totalMs: number; lastMs: number };
type DecisionCount = { attempts: number; rust: number; ts: number; none: number; candidates: number; blocked: number; last: Decision };
type Event = { at: string; type: "rust-call" | "decision"; name: string; outcome: string; detail?: string; durationMs?: number };
type Probe = { snapshot: () => unknown; load?: () => Promise<unknown> };

const probes: Partial<Record<Bridge, Probe>> = {};
const calls: Record<string, FunctionCount> = {};
const decisions: Record<string, DecisionCount> = {};
const events: Event[] = [];
let tracing = false;
let testEnabled = false;

// Capture initialization calls even before React mounts/installs the console command.
export function auditEnabled(): boolean {
  if (testEnabled) return true;
  try { return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("bridgeAudit") === "1"; }
  catch { return false; }
}

export function registerAuditProbe(bridge: Bridge, probe: Probe): void {
  probes[bridge] = probe;
}
function emit(event: Event): void {
  events.push(event);
  if (events.length > 80) events.shift();
  if (tracing) console.info("[WASM audit]", event);
}
function ms(value: number): number { return Math.round(value * 1000) / 1000; }

/** Counts an actual invocation of a callable native export, NOT just a lookup. */
export function auditRustCall<T>(name: string, invoke: () => T): T {
  if (!auditEnabled()) return invoke();
  const start = performance.now();
  let outcome: "succeeded" | "failed" = "failed";
  try { const value = invoke(); outcome = "succeeded"; return value; }
  finally {
    const elapsed = ms(performance.now() - start);
    const count = calls[name] ??= { calls: 0, succeeded: 0, failed: 0, totalMs: 0, lastMs: 0 };
    count.calls++;
    count[outcome]++;
    count.lastMs = elapsed;
    count.totalMs = ms(count.totalMs + elapsed);
    emit({ at: new Date().toISOString(), type: "rust-call", name, outcome, durationMs: elapsed });
  }
}
export async function auditRustAsyncCall<T>(name: string, invoke: () => Promise<T>): Promise<T> {
  if (!auditEnabled()) return invoke();
  const start = performance.now();
  let outcome: "succeeded" | "failed" = "failed";
  try { const value = await invoke(); outcome = "succeeded"; return value; }
  finally {
    const elapsed = ms(performance.now() - start);
    const count = calls[name] ??= { calls: 0, succeeded: 0, failed: 0, totalMs: 0, lastMs: 0 };
    count.calls++;
    count[outcome]++;
    count.lastMs = elapsed;
    count.totalMs = ms(count.totalMs + elapsed);
    emit({ at: new Date().toISOString(), type: "rust-call", name, outcome, durationMs: elapsed });
  }
}

export function auditDecision(decision: Decision): void {
  if (!auditEnabled()) return;
  // Only short, classed reasons belong here: never pass raw exception messages,
  // source text, import results or other user data into an audit event.
  const key = `${decision.bridge}.${decision.operation}`;
  const count = decisions[key] ??= { attempts: 0, rust: 0, ts: 0, none: 0, candidates: 0, blocked: 0, last: decision };
  count.attempts++;
  count[decision.result]++;
  if (decision.candidate) count.candidates++;
  if (decision.guard === "blocked") count.blocked++;
  count.last = { ...decision };
  emit({ at: new Date().toISOString(), type: "decision", name: key,
    outcome: `${decision.result} / ${decision.guard}`, detail: decision.reason });
}

export function bridgeAuditSnapshot() {
  // Show zero counts for available exports too: 'not invoked' is not 'not
  // exported'. Command-session methods are listed only when its class exists;
  // whether the ABI and document are admissible is decided at open time.
  const modules = Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, probe.snapshot()]));
  const imp = modules.imports as { availableFunctions?: string[]; sessionExportPresent?: boolean } | undefined;
  const geo = modules.geometry as { availableFunctions?: string[] } | undefined;
  const available = [
    ...(imp?.availableFunctions ?? []).map(k => k === "default" ? "x-wasm.init" : `x-wasm.${k}`),
    ...(imp?.sessionExportPresent ? ["new", "state", "getNode", "getShape", "renameNode", "moveNode", "resizeNode", "booleanNode", "strokeNode", "previewOffset", "offsetNode", "undo", "redo", "exportX", "free"]
      .map(k => `x-wasm.RustDocumentSession.${k}`) : []),
    ...(geo?.availableFunctions ?? []).map(k => `x-geo.${k}`),
  ];
  const empty = (): FunctionCount => ({ calls: 0, succeeded: 0, failed: 0, totalMs: 0, lastMs: 0 });
  return {
    enabled: auditEnabled(),
    // status getters expose *different* module states, not a shared hasWasm flag.
    modules,
    functions: Object.fromEntries([...available.map(name => [name, empty()] as const),
      ...Object.entries(calls).map(([name, value]) => [name, { ...value }] as const)]),
    decisions: Object.fromEntries(Object.entries(decisions).map(([name, value]) => [name, { ...value, last: { ...value.last } }])),
    recent: events.map(e => ({ ...e })),
  };
}

export function resetBridgeAudit(): void {
  for (const key of Object.keys(calls)) delete calls[key];
  for (const key of Object.keys(decisions)) delete decisions[key];
  events.length = 0;
}

/** Check bytes/MIME, not just HTTP status: a Vite SPA fallback can return HTML 200. */
export async function inspectBridgeAssets(): Promise<Record<string, unknown>> {
  if (typeof window === "undefined") return {};
  const imports = probes.imports?.snapshot() as { assets?: { glue: string; wasm: string } } | undefined;
  const geometry = probes.geometry?.snapshot() as { asset?: string } | undefined;
  const paths: Record<string, string | undefined> = {
    "x-wasm glue": imports?.assets?.glue,
    "x-wasm binary": imports?.assets?.wasm,
    "x-geo binary": geometry?.asset,
  };
  const result: Record<string, unknown> = {};
  for (const [name, url] of Object.entries(paths)) {
    if (!url) { result[name] = { error: "bridge not registered" }; continue; }
    try {
      const response = await fetch(url, { cache: "no-store" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mime = response.headers.get("content-type") ?? "";
      const isWasm = name !== "x-wasm glue";
      const magic = bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109 &&
        bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0;
      const prefix = new TextDecoder().decode(bytes.subarray(0, 128)).trimStart().toLowerCase();
      const html = prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
      result[name] = { url, status: response.status, mime, bytes: bytes.length,
        plausibleAsset: response.ok && (isWasm ? magic : !html && /(?:javascript|ecmascript)/i.test(mime)),
        ...isWasm ? { wasmMagic: magic } : { htmlFallback: html } };
    } catch (e) {
      result[name] = { url, error: e instanceof Error ? e.name : "fetch failed" };
    }
  }
  return result;
}

export interface BridgeAuditConsole {
  snapshot: typeof bridgeAuditSnapshot;
  reset: typeof resetBridgeAudit;
  assets: typeof inspectBridgeAssets;
  load: () => Promise<ReturnType<typeof bridgeAuditSnapshot>>;
  trace: (on?: boolean) => boolean;
  report: () => ReturnType<typeof bridgeAuditSnapshot>;
}
declare global { interface Window { __xWasmAudit?: BridgeAuditConsole } }

/** Only expose a console command when explicitly requested in the real URL. */
export function installBrowserBridgeAudit(): void {
  if (!auditEnabled() || typeof window === "undefined") return;
  window.__xWasmAudit = {
    snapshot: bridgeAuditSnapshot,
    reset: resetBridgeAudit,
    assets: inspectBridgeAssets,
    async load() {
      await Promise.all(Object.values(probes).map(probe => probe.load?.()));
      return bridgeAuditSnapshot();
    },
    trace(on = true) { tracing = on; return tracing; },
    report() {
      const snapshot = bridgeAuditSnapshot();
      console.info("[WASM audit] modules (loading is not a Rust operation)", snapshot.modules);
      console.table(Object.entries(snapshot.functions).map(([name, count]) => ({ name, ...count })));
      console.table(Object.entries(snapshot.decisions).map(([name, count]) => ({
        operation: name, attempts: count.attempts, candidateAttempts: count.candidates,
        rustUsed: count.rust, tsUsed: count.ts, guardBlocked: count.blocked,
        lastGuard: count.last.guard, lastReason: count.last.reason,
      })));
      return snapshot;
    },
  };
  console.info("[WASM audit] Opt-in: __xWasmAudit.trace(true); await __xWasmAudit.load(); __xWasmAudit.report(). Audit events omit document data; existing geometry warnings may print comparator metrics.");
}

/** Test seam for node/Vite tests that have no browser query string. */
export function __enableBridgeAuditForTests(enabled: boolean): void {
  testEnabled = enabled;
  tracing = false;
  resetBridgeAudit();
}
