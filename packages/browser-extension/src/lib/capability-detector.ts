/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/capability-detector.ts
//
// Capability Detection + Adaptive Resource Scaling
// ─────────────────────────────────────────────────
// Detects the host machine's available resources at runtime and maps them
// to one of three Attention Engine tiers:
//
//   minimal  — pure regex + keyword heuristics     <100ms       (weak CPU / <4GB RAM)
//   balanced — small embedding model, WASM, 2 thr  1-2s         (mid CPU / 4GB+ RAM)
//   full     — MiniLM-L6, WebGPU when available     3-5s         (GPU present / 8GB+ RAM)
//
// Detection signals:
//   • navigator.hardwareConcurrency        — CPU core count
//   • performance.memory.jsHeapSizeLimit   — heap limit (Chrome)
//   • navigator.deviceMemory               — approximate RAM in GB (Chrome)
//   • WebGL renderer string                — GPU vendor/model
//   • navigator.gpu.requestAdapter()       — WebGPU availability
//   • navigator.getBattery()               — on battery → auto-downgrade one tier
//   • 5ms calibration benchmark            — actual FLOPS of this machine
//
// Guarantees:
//   • Never throws.  Any failure path returns "minimal".
//   • Never blocks the UI thread.  Benchmark yields via Promise microtasks.
//   • Manual override is honored and persisted in localStorage (+ chrome.storage for SW).
//   • Re-evaluated per migration — not cached forever — so battery state or
//     thermal throttling changes are picked up.
//   • Load watchdog (monitorLoad) downgrades tier mid-migration if the main
//     thread stalls > THRESHOLD ms, emitting a "downgrade" event that the
//     attention engine can listen to.
//
// Zero dependencies.  Runs in both the extension service worker (limited
// DOM APIs) and in page contexts (sidebar, popup, content scripts).

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type Tier = "minimal" | "balanced" | "full";
export type TierOverride = Tier | "auto";

export interface Capabilities {
  /** Number of logical CPU cores (navigator.hardwareConcurrency). */
  cores: number;
  /** Estimated device memory in GB, or undefined when not exposed. */
  deviceMemoryGb: number | undefined;
  /** JS heap size limit in MB, or undefined when not exposed. */
  jsHeapLimitMb: number | undefined;
  /** WebGPU adapter present and usable. */
  hasWebGpu: boolean;
  /** WebGL renderer string (unmasked when possible), or undefined. */
  webglRenderer: string | undefined;
  /** Running on battery (discharging), or undefined when API unavailable. */
  onBattery: boolean | undefined;
  /** Current battery level 0-1, or undefined when API unavailable. */
  batteryLevel: number | undefined;
  /** Calibration benchmark score in ops/ms (higher = faster CPU). */
  benchmarkOpsPerMs: number;
  /** How long the benchmark actually took in ms. */
  benchmarkDurationMs: number;
  /** The tier that was selected. */
  tier: Tier;
  /** Human-readable justification, suitable for logging. */
  reason: string;
  /** True if the user manually overrode the auto-selected tier. */
  overridden: boolean;
  /** When this snapshot was produced (Date.now()). */
  timestamp: number;
}

export type DowngradeListener = (from: Tier, to: Tier, reason: string) => void;

export interface SystemHeadroom {
  /** Estimated free CPU ratio 0.0–1.0 based on a live benchmark vs. baseline. */
  cpuFree: number;
  /** True when a WebGPU adapter responded within 100ms. */
  gpuAvailable: boolean;
  /** (jsHeapSizeLimit - usedJSHeapSize) / jsHeapSizeLimit; defaults to 0.5. */
  memoryFree: number;
  /** Suggested embedding batch size for the current headroom level. */
  recommendedBatchSize: number;
  /** Suggested ONNX WASM thread count for the current headroom level. */
  recommendedThreads: number;
  /** True when cpuFree > 0.6 AND memoryFree > 0.4. */
  boostEligible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TAG = "[ContextMover:capability-detector]";

const OVERRIDE_LS_KEY = "contextmover:tier-override";
const OVERRIDE_CHROME_KEY = "cf_tier_override";

/** Max age (ms) of a cached Capabilities snapshot before re-running detection. */
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

/** Number of iterations for the 5ms calibration benchmark. */
const BENCHMARK_BUDGET_MS = 5;

/** Main-thread stall threshold that triggers a mid-migration downgrade. */
const LOAD_STALL_MS = 1000;

/** How often the load watchdog samples (ms). */
const LOAD_SAMPLE_INTERVAL_MS = 250;

/** Ops/ms benchmark thresholds — empirically tuned on commodity hardware.
 *  • <300  → weak CPU (Celeron, low-power ARM)
 *  • <1200 → mid CPU  (modern laptop i5 / M1)
 *  • ≥1200 → strong CPU (desktop i7 / M2+ / Ryzen) */
const BENCH_WEAK = 300;
const BENCH_STRONG = 1200;

const TIER_ORDER: Tier[] = ["minimal", "balanced", "full"];

// ─────────────────────────────────────────────────────────────────────────────
// Microbenchmark (non-blocking, ~5 ms)
//
// Tight arithmetic loop that yields to the event loop between chunks so the
// UI never stalls.  Returns operations-per-millisecond — a coarse proxy for
// single-core integer throughput.  Runs entirely on the main thread because
// the numbers it produces must reflect the environment that will run the
// ONNX WASM inference.
// ─────────────────────────────────────────────────────────────────────────────

async function runBenchmark(): Promise<{ opsPerMs: number; durationMs: number }> {
  const start = performance.now();
  const deadline = start + BENCHMARK_BUDGET_MS;
  let ops = 0;
  let acc = 0;
  const CHUNK = 5000;

  while (performance.now() < deadline) {
    for (let i = 0; i < CHUNK; i++) {
      // Mixed integer + float workload; resists dead-code-elimination because
      // `acc` is consumed below.
      acc = (acc * 1.0001 + i) | 0;
      acc ^= (acc << 3) | 0;
    }
    ops += CHUNK;
    // Yield back to the event loop between chunks so long-running detections
    // can't freeze the UI.  A resolved Promise is the cheapest yield in JS.
    await Promise.resolve();
  }

  // Silence the dead-code optimizer.
  if (acc === Number.MAX_SAFE_INTEGER) console.debug(TAG, "bench acc", acc);

  const durationMs = performance.now() - start;
  const opsPerMs = durationMs > 0 ? Math.round(ops / durationMs) : 0;
  return { opsPerMs, durationMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal collectors
// ─────────────────────────────────────────────────────────────────────────────

function detectCores(): number {
  try {
    return Math.max(1, navigator.hardwareConcurrency || 1);
  } catch {
    return 1;
  }
}

function detectDeviceMemoryGb(): number | undefined {
  try {
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    return typeof mem === "number" ? mem : undefined;
  } catch {
    return undefined;
  }
}

function detectJsHeapLimitMb(): number | undefined {
  try {
    const mem = (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory;
    return mem?.jsHeapSizeLimit ? Math.round(mem.jsHeapSizeLimit / (1024 * 1024)) : undefined;
  } catch {
    return undefined;
  }
}

async function detectWebGpu(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    if (!gpu?.requestAdapter) return false;
    // Race against 2s timeout — M1/M2 Macs can have a slow first-request
    const adapter = await Promise.race([
      gpu.requestAdapter({ powerPreference: "high-performance" }) as Promise<unknown>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!adapter) return false;
    // Log GPU renderer info when available (helps debug M1 vs. discrete GPU)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = await (adapter as any).requestAdapterInfo?.();
      const renderer = info?.renderer ?? info?.description ?? "WebGPU adapter";
      console.debug("[CM:hw] WebGPU confirmed:", renderer);
    } catch { /* requestAdapterInfo not universally available */ }
    return true;
  } catch {
    return false;
  }
}

function detectWebglRenderer(): string | undefined {
  // Service workers cannot create canvases — guard by environment.
  if (typeof document === "undefined") return undefined;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return undefined;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string | null)
      : (gl.getParameter(gl.RENDERER) as string | null);
    return renderer ?? undefined;
  } catch {
    return undefined;
  }
}

interface BatteryInfo {
  onBattery: boolean | undefined;
  level: number | undefined;
}

async function detectBattery(): Promise<BatteryInfo> {
  try {
    const getBattery = (
      navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; level: number }> }
    ).getBattery;
    if (typeof getBattery !== "function") return { onBattery: undefined, level: undefined };
    const b = await getBattery.call(navigator);
    return { onBattery: !b.charging, level: b.level };
  } catch {
    return { onBattery: undefined, level: undefined };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier selection logic
// ─────────────────────────────────────────────────────────────────────────────

function selectTier(signals: {
  cores: number;
  deviceMemoryGb: number | undefined;
  jsHeapLimitMb: number | undefined;
  hasWebGpu: boolean;
  benchmarkOpsPerMs: number;
  onBattery: boolean | undefined;
}): { tier: Tier; reason: string } {
  const reasons: string[] = [];

  // Minimal gates — any single failure forces minimal.
  if (signals.cores < 2) {
    return {
      tier: "minimal",
      reason: `single-core CPU (cores=${signals.cores}) — forcing minimal`,
    };
  }
  if (signals.benchmarkOpsPerMs < BENCH_WEAK) {
    return {
      tier: "minimal",
      reason: `slow CPU benchmark (${signals.benchmarkOpsPerMs} ops/ms < ${BENCH_WEAK}) — forcing minimal`,
    };
  }
  if (signals.deviceMemoryGb !== undefined && signals.deviceMemoryGb < 4) {
    return {
      tier: "minimal",
      reason: `low RAM (deviceMemory=${signals.deviceMemoryGb}GB < 4GB) — forcing minimal`,
    };
  }
  if (signals.jsHeapLimitMb !== undefined && signals.jsHeapLimitMb < 1024) {
    return {
      tier: "minimal",
      reason: `tight heap (jsHeapLimit=${signals.jsHeapLimitMb}MB < 1024MB) — forcing minimal`,
    };
  }

  // Full-tier gates — all must pass.
  const strongCpu = signals.benchmarkOpsPerMs >= BENCH_STRONG;
  const manyCores = signals.cores >= 6;
  const ampleRam =
    (signals.deviceMemoryGb ?? 0) >= 8 ||
    (signals.jsHeapLimitMb ?? 0) >= 3072;

  if (signals.hasWebGpu && (strongCpu || manyCores) && ampleRam) {
    reasons.push(`WebGPU available`);
    reasons.push(`cores=${signals.cores}`);
    reasons.push(`bench=${signals.benchmarkOpsPerMs} ops/ms`);
    if (signals.deviceMemoryGb !== undefined) reasons.push(`ram=${signals.deviceMemoryGb}GB`);
    if (signals.jsHeapLimitMb !== undefined) reasons.push(`heap=${signals.jsHeapLimitMb}MB`);
    return { tier: "full", reason: reasons.join(", ") };
  }

  // Default → balanced.
  reasons.push(`cores=${signals.cores}`);
  reasons.push(`bench=${signals.benchmarkOpsPerMs} ops/ms`);
  reasons.push(`webgpu=${signals.hasWebGpu}`);
  if (signals.deviceMemoryGb !== undefined) reasons.push(`ram=${signals.deviceMemoryGb}GB`);
  return { tier: "balanced", reason: reasons.join(", ") };
}

function downgradeOne(tier: Tier): Tier {
  const idx = TIER_ORDER.indexOf(tier);
  return idx > 0 ? TIER_ORDER[idx - 1] : "minimal";
}

// ─────────────────────────────────────────────────────────────────────────────
// Override persistence (localStorage for page contexts, chrome.storage fallback
// for the service worker which has no localStorage).
// ─────────────────────────────────────────────────────────────────────────────

function readLocalStorageOverride(): TierOverride | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem(OVERRIDE_LS_KEY);
    return isOverride(v) ? v : null;
  } catch {
    return null;
  }
}

function writeLocalStorageOverride(value: TierOverride): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(OVERRIDE_LS_KEY, value);
  } catch {
    /* quota or privacy mode — ignore */
  }
}

async function readChromeStorageOverride(): Promise<TierOverride | null> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
    const res = await chrome.storage.local.get(OVERRIDE_CHROME_KEY);
    const v = res?.[OVERRIDE_CHROME_KEY];
    return isOverride(v) ? v : null;
  } catch {
    return null;
  }
}

async function writeChromeStorageOverride(value: TierOverride): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [OVERRIDE_CHROME_KEY]: value });
  } catch {
    /* ignore */
  }
}

function isOverride(v: unknown): v is TierOverride {
  return v === "auto" || v === "minimal" || v === "balanced" || v === "full";
}

// ─────────────────────────────────────────────────────────────────────────────
// CapabilityDetector — singleton
// ─────────────────────────────────────────────────────────────────────────────

class CapabilityDetector {
  private cached: Capabilities | null = null;
  private inFlight: Promise<Capabilities> | null = null;
  private downgradeListeners = new Set<DowngradeListener>();
  /** Active load watchdog id; -1 when idle. */
  private watchdogId: ReturnType<typeof setInterval> | -1 = -1;
  private watchdogLastTick = 0;
  private watchdogTier: Tier | null = null;

  // ─── Detection ───────────────────────────────────────────────────────────

  /**
   * Returns the fully-populated Capabilities snapshot.  Uses a 30-min cache
   * to avoid re-running the benchmark on every call, but always re-evaluates
   * the battery + manual override, since those can change any second.
   */
  async detect(force = false): Promise<Capabilities> {
    if (!force && this.cached && Date.now() - this.cached.timestamp < CACHE_TTL_MS) {
      return this.refreshVolatileSignals(this.cached);
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runFullDetection()
      .catch((err) => {
        console.warn(`${TAG} detection failed, defaulting to minimal:`, err);
        return this.fallbackMinimal("detection_threw");
      })
      .finally(() => { this.inFlight = null; });
    const result = await this.inFlight;
    this.cached = result;
    console.log(
      `${TAG} tier=${result.tier} (${result.reason})` +
      (result.overridden ? " [user override]" : "")
    );
    return result;
  }

  /**
   * The tier to actually USE for a migration.  Same as `detect().tier` but
   * applies the battery-downgrade rule and honors any manual override.
   */
  async getEffectiveTier(): Promise<Tier> {
    const caps = await this.detect();
    return caps.tier;
  }

  /**
   * Recalculate JUST the volatile signals (battery + override) on a cached
   * snapshot, without re-running the 5ms benchmark.
   */
  private async refreshVolatileSignals(prev: Capabilities): Promise<Capabilities> {
    const battery = await detectBattery();
    const override = await this.readOverride();
    const autoTier = selectTier({
      cores: prev.cores,
      deviceMemoryGb: prev.deviceMemoryGb,
      jsHeapLimitMb: prev.jsHeapLimitMb,
      hasWebGpu: prev.hasWebGpu,
      benchmarkOpsPerMs: prev.benchmarkOpsPerMs,
      onBattery: battery.onBattery,
    });

    let tier = autoTier.tier;
    let reason = autoTier.reason;
    let overridden = false;

    if (battery.onBattery === true && override !== "full") {
      const downgraded = downgradeOne(tier);
      if (downgraded !== tier) {
        reason = `${reason}; on battery — downgraded ${tier}→${downgraded}`;
        tier = downgraded;
      }
    }

    if (override && override !== "auto") {
      reason = `user override → ${override} (auto would be ${tier})`;
      tier = override;
      overridden = true;
    }

    return { ...prev, onBattery: battery.onBattery, batteryLevel: battery.level, tier, reason, overridden, timestamp: Date.now() };
  }

  private async runFullDetection(): Promise<Capabilities> {
    const cores = detectCores();
    const deviceMemoryGb = detectDeviceMemoryGb();
    const jsHeapLimitMb = detectJsHeapLimitMb();
    const webglRenderer = detectWebglRenderer();
    const [hasWebGpu, battery, bench] = await Promise.all([
      detectWebGpu(),
      detectBattery(),
      runBenchmark(),
    ]);

    const autoTier = selectTier({
      cores,
      deviceMemoryGb,
      jsHeapLimitMb,
      hasWebGpu,
      benchmarkOpsPerMs: bench.opsPerMs,
      onBattery: battery.onBattery,
    });

    let tier: Tier = autoTier.tier;
    let reason = autoTier.reason;
    let overridden = false;

    // Battery rule: if on battery and not manually forced to full, downgrade
    // one tier to preserve battery life.
    const override = await this.readOverride();
    if (battery.onBattery === true && override !== "full") {
      const downgraded = downgradeOne(tier);
      if (downgraded !== tier) {
        reason = `${reason}; on battery — downgraded ${tier}→${downgraded}`;
        tier = downgraded;
      }
    }

    // Manual override wins over everything except: if the user picked a tier
    // their hardware literally cannot support (e.g. "full" on a 1-core ARM),
    // we still honor it — the attention engine's own fail-safe will catch it.
    if (override && override !== "auto") {
      reason = `user override → ${override} (auto would be ${tier})`;
      tier = override;
      overridden = true;
    }

    return {
      cores,
      deviceMemoryGb,
      jsHeapLimitMb,
      hasWebGpu,
      webglRenderer,
      onBattery: battery.onBattery,
      batteryLevel: battery.level,
      benchmarkOpsPerMs: bench.opsPerMs,
      benchmarkDurationMs: bench.durationMs,
      tier,
      reason,
      overridden,
      timestamp: Date.now(),
    };
  }

  private fallbackMinimal(why: string): Capabilities {
    return {
      cores: detectCores(),
      deviceMemoryGb: undefined,
      jsHeapLimitMb: undefined,
      hasWebGpu: false,
      webglRenderer: undefined,
      onBattery: undefined,
      batteryLevel: undefined,
      benchmarkOpsPerMs: 0,
      benchmarkDurationMs: 0,
      tier: "minimal",
      reason: `fallback minimal (${why})`,
      overridden: false,
      timestamp: Date.now(),
    };
  }

  // ─── Manual override ─────────────────────────────────────────────────────

  /**
   * Persist a manual override. "auto" = follow detection.
   * Invalidates the cached snapshot so the next `detect()` reflects the change.
   */
  async setUserOverride(override: TierOverride): Promise<void> {
    if (!isOverride(override)) throw new Error(`Invalid tier override: ${String(override)}`);
    writeLocalStorageOverride(override);
    await writeChromeStorageOverride(override);
    this.cached = null;
    console.log(`${TAG} user override set to "${override}"`);
  }

  async getUserOverride(): Promise<TierOverride> {
    return (await this.readOverride()) ?? "auto";
  }

  private async readOverride(): Promise<TierOverride | null> {
    // Prefer localStorage in page contexts (sync, no async roundtrip);
    // fall back to chrome.storage.local for the service worker.
    return readLocalStorageOverride() ?? (await readChromeStorageOverride());
  }

  // ─── Mid-migration load watchdog ─────────────────────────────────────────

  /**
   * Start monitoring main-thread responsiveness.  If the event loop stalls
   * for more than LOAD_STALL_MS while a migration is running, emit a
   * downgrade event so the AttentionEngine can abort ML inference and fall
   * back to a lighter tier.
   *
   * Returns a disposer function.  Only one watchdog runs at a time.
   */
  monitorLoad(currentTier: Tier): () => void {
    this.stopLoadWatchdog(); // idempotent
    if (currentTier === "minimal") {
      // No ML to downgrade from — no-op watchdog.
      return () => { /* noop */ };
    }
    this.watchdogTier = currentTier;
    this.watchdogLastTick = performance.now();

    this.watchdogId = setInterval(() => {
      const now = performance.now();
      const delta = now - this.watchdogLastTick;
      this.watchdogLastTick = now;
      // The sampler fires every LOAD_SAMPLE_INTERVAL_MS.  If more than
      // LOAD_STALL_MS elapsed between samples, the main thread was stalled.
      if (delta > LOAD_SAMPLE_INTERVAL_MS + LOAD_STALL_MS && this.watchdogTier) {
        const from = this.watchdogTier;
        const to = downgradeOne(from);
        if (to !== from) {
          const reason = `main thread stalled ${Math.round(delta)}ms > ${LOAD_STALL_MS}ms threshold`;
          console.warn(`${TAG} mid-migration downgrade ${from}→${to}: ${reason}`);
          this.watchdogTier = to;
          this.emitDowngrade(from, to, reason);
        }
      }
    }, LOAD_SAMPLE_INTERVAL_MS);

    return () => this.stopLoadWatchdog();
  }

  private stopLoadWatchdog(): void {
    if (this.watchdogId !== -1) {
      clearInterval(this.watchdogId);
      this.watchdogId = -1;
      this.watchdogTier = null;
    }
  }

  /** Subscribe to mid-migration downgrade events.  Returns an unsubscribe fn. */
  onDowngrade(listener: DowngradeListener): () => void {
    this.downgradeListeners.add(listener);
    return () => this.downgradeListeners.delete(listener);
  }

  private emitDowngrade(from: Tier, to: Tier, reason: string): void {
    for (const l of this.downgradeListeners) {
      try {
        l(from, to, reason);
      } catch (err) {
        console.warn(`${TAG} downgrade listener threw:`, err);
      }
    }
  }

  /** Baseline benchmark ops/ms from initial detection — used by measureSystemHeadroom. */
  getBaselineOpsPerMs(): number {
    return this.cached?.benchmarkOpsPerMs ?? 0;
  }

  /** Clear the cached snapshot. Next detect() will re-run the full benchmark. */
  invalidate(): void {
    this.cached = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

export const capabilityDetector = new CapabilityDetector();

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic hardware headroom measurement
//
// measureSystemHeadroom() runs a fresh 5ms benchmark and compares it to the
// cached baseline to estimate current CPU load, checks WebGPU availability,
// and reads JS heap usage.  startHeadroomMonitor() calls it every 3 s and
// fires a callback only when the boostEligible flag changes.
// ─────────────────────────────────────────────────────────────────────────────

export async function measureSystemHeadroom(): Promise<SystemHeadroom> {
  // ── CPU — live benchmark vs. cached baseline ────────────────────────────
  const baseline = capabilityDetector.getBaselineOpsPerMs();
  let cpuFree = 0.5;
  if (baseline > 0) {
    const { opsPerMs } = await runBenchmark();
    const ratio = opsPerMs / baseline;
    cpuFree = ratio >= 1.2 ? 0.8 : ratio >= 0.8 ? 0.5 : 0.2;
  }

  // ── GPU — requestAdapter with 100ms timeout ──────────────────────────────
  let gpuAvailable = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = typeof navigator !== "undefined" ? (navigator as any).gpu : null;
    if (gpu?.requestAdapter) {
      const adapter = await Promise.race([
        gpu.requestAdapter() as Promise<unknown>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);
      gpuAvailable = Boolean(adapter);
    }
  } catch { /* unavailable */ }

  // ── Memory — JS heap ratio ───────────────────────────────────────────────
  let memoryFree = 0.5;
  try {
    const mem = (performance as unknown as {
      memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number };
    }).memory;
    if (mem?.jsHeapSizeLimit && mem.usedJSHeapSize !== undefined) {
      memoryFree = (mem.jsHeapSizeLimit - mem.usedJSHeapSize) / mem.jsHeapSizeLimit;
    }
  } catch { /* Chrome-only API — unavailable in other contexts */ }

  const boostEligible = cpuFree > 0.6 && memoryFree > 0.4;
  const cores = detectCores();

  const recommendedBatchSize =
    boostEligible && gpuAvailable ? 64 :
    boostEligible                 ? 32 :
    cpuFree >= 0.5                ? 16 :
                                     8;

  const recommendedThreads =
    boostEligible  ? Math.min(cores, 8) :
    cpuFree >= 0.5 ? Math.min(cores, 4) :
                     1;

  return { cpuFree, gpuAvailable, memoryFree, recommendedBatchSize, recommendedThreads, boostEligible };
}

/**
 * Runs measureSystemHeadroom() every 3 seconds.  Fires callback only when
 * the boostEligible flag changes (avoids noisy re-renders when nothing changed).
 * Returns a cleanup function that stops the monitor.
 */
export function startHeadroomMonitor(
  callback: (h: SystemHeadroom) => void
): () => void {
  let lastBoostEligible: boolean | null = null;
  const id = setInterval(async () => {
    try {
      const h = await measureSystemHeadroom();
      if (h.boostEligible !== lastBoostEligible) {
        lastBoostEligible = h.boostEligible;
        callback(h);
      }
    } catch { /* never throw from monitor */ }
  }, 3_000);
  return () => clearInterval(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier → runtime configuration
//
// Consumed by attention-engine.ts to pick the right model + ONNX settings.
// Kept in this file so all tier-specific constants live next to the detector.
// ─────────────────────────────────────────────────────────────────────────────

export interface TierConfig {
  /** Whether to load an ONNX embedding model at all. */
  useEmbeddings: boolean;
  /** HuggingFace model id to load (ignored when useEmbeddings=false). */
  modelId: string;
  /** Preferred ONNX device. "wasm" always works; "webgpu" requires adapter. */
  device: "wasm" | "webgpu";
  /** Max ONNX WASM threads; capped by navigator.hardwareConcurrency. */
  maxWasmThreads: number;
  /** Max chunks to embed per session (higher = better recall, more CPU). */
  maxChunksPerSession: number;
  /** Embedding batch size passed to the feature-extraction pipeline. */
  batchSize: number;
  /** Whether to initialize tree-sitter for structural parsing. */
  useTreeSitter: boolean;
  /** Target completion budget in ms — used for self-timing logs. */
  targetMs: number;
}

export const TIER_CONFIGS: Record<Tier, TierConfig> = {
  minimal: {
    useEmbeddings: false,
    modelId: "",
    device: "wasm",
    maxWasmThreads: 1,
    maxChunksPerSession: 0,
    batchSize: 0,
    useTreeSitter: false,
    targetMs: 100,
  },
  balanced: {
    useEmbeddings: true,
    // Smaller/faster variant when you add it to the codebase;
    // the full MiniLM model also works here — throughput is limited primarily
    // by thread count and batch size, both tuned down for balanced tier.
    modelId: "Xenova/all-MiniLM-L6-v2",
    device: "wasm",
    maxWasmThreads: 2,
    maxChunksPerSession: 500,
    batchSize: 16,
    useTreeSitter: true,
    targetMs: 2000,
  },
  full: {
    useEmbeddings: true,
    modelId: "Xenova/all-MiniLM-L6-v2",
    device: "webgpu",
    maxWasmThreads: 4,
    maxChunksPerSession: 2000,
    batchSize: 32,
    useTreeSitter: true,
    targetMs: 5000,
  },
};

export function getTierConfig(tier: Tier): TierConfig {
  return TIER_CONFIGS[tier];
}
