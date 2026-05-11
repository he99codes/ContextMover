// packages/browser-extension/src/lib/perf/metrics.ts
//
// Lightweight, in-memory perf tracker. Logs every measurement,
// retains last N for table reports. No persistence.

interface PerfMetric {
  name: string;
  duration: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

class PerfTracker {
  private metrics: PerfMetric[] = [];
  private readonly maxMetrics = 200;

  track(name: string, duration: number, metadata?: Record<string, unknown>): void {
    this.metrics.push({ name, duration, metadata, timestamp: Date.now() });
    if (this.metrics.length > this.maxMetrics) this.metrics.shift();
    console.log(`[CM:perf] ${name}: ${duration.toFixed(1)}ms`, metadata ?? "");
  }

  async measure<T>(
    name: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const t0 = performance.now();
    try {
      const result = await fn();
      this.track(name, performance.now() - t0, metadata);
      return result;
    } catch (err) {
      this.track(`${name}:error`, performance.now() - t0, {
        ...metadata,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  getReport(): Record<string, { avg: number; min: number; max: number; count: number }> {
    const byName = new Map<string, number[]>();
    for (const m of this.metrics) {
      const arr = byName.get(m.name) ?? [];
      arr.push(m.duration);
      byName.set(m.name, arr);
    }
    const report: Record<string, { avg: number; min: number; max: number; count: number }> = {};
    for (const [name, durations] of byName) {
      report[name] = {
        avg: +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1),
        min: +Math.min(...durations).toFixed(1),
        max: +Math.max(...durations).toFixed(1),
        count: durations.length,
      };
    }
    return report;
  }

  logReport(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = console;
    if (typeof c.table === "function") c.table(this.getReport());
    else console.log(this.getReport());
  }

  reset(): void { this.metrics = []; }
}

export const perf = new PerfTracker();
