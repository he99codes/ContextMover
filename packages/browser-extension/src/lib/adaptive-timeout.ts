import { getHardwareProfile } from "./attention-engine";
export type AdaptiveOp = "embedding_query" | "semantic_search" | "background_index";
type Sample = { n: number; s: number };
const MAX = 20, MIN = 3, MUL = 3;
const FLOOR: Record<AdaptiveOp, number> = { embedding_query: 15000, semantic_search: 20000, background_index: 20000 };
const CAP: Record<AdaptiveOp, number> = { embedding_query: 90000, semantic_search: 60000, background_index: 300000 };
function p95(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.min(Math.floor(s.length*0.95), s.length-1)]; }
class LatencyTracker {
  private w = new Map<AdaptiveOp, Sample[]>();
  private tc: Record<string, number> = {};
  record(op: AdaptiveOp, ms: number, sz: number): void {
    if (sz <= 0) sz = 1;
    let a = this.w.get(op); if (!a) { a = []; this.w.set(op, a); }
    a.push({ n: ms / sz, s: sz }); if (a.length > MAX) a.shift();
  }
  private async tierMul(): Promise<number> {
    if (this.tc.m) return this.tc.m;
    try { const h = await getHardwareProfile(); this.tc.m = h.tier === "full" ? 0.8 : h.tier === "minimal" ? 1.5 : 1.0; }
    catch { this.tc.m = 1.0; } return this.tc.m;
  }
  async getTimeoutMs(op: AdaptiveOp, size: number): Promise<number> {
    const a = this.w.get(op); if (!a || a.length < MIN) return Math.min(FLOOR[op] * await this.tierMul() * Math.max(size, 1), CAP[op]);
    const p = p95(a.map(x => x.n)); return Math.min(Math.max(p * MUL * Math.max(size, 1), FLOOR[op]), CAP[op]);
  }
}
export const latencyTracker = new LatencyTracker();

export class StallDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rejectFn: ((e: Error) => void) | null = null;
  private firstReset = true;
  // graceMs: extra time before first progress event (offscreen may be busy with previous job)
  // stallMs: time between progress events after the first one
  constructor(private stallMs: number = 60_000, private graceMs: number = 120_000) {}
  start(): Promise<never> {
    return new Promise((_, reject) => {
      this.rejectFn = reject;
      this.firstReset = true;
      this.arm();
    });
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const ms = this.firstReset ? this.stallMs + this.graceMs : this.stallMs;
    this.timer = setTimeout(() => { if (this.rejectFn) this.rejectFn(new Error("stall_detected")); }, ms);
  }
  reset(): void {
    this.firstReset = false;
    this.arm();
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.rejectFn = null; this.firstReset = true; }
}
