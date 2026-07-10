/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/lib/capture/health-monitor.ts
// Tracks capture success rate per platform over a sliding window.
// Stores alerts in chrome.storage.local so the sidebar can display them.

interface HealthRecord {
  platform: string;
  timestamp: number;
  success: boolean;
  userCount: number;
  assistantCount: number;
  detectionMethod: string;
  errors: string[];
}

export interface CaptureAlert {
  platform: string;
  successRate: number;
  timestamp: number;
  message: string;
}

export class CaptureHealthMonitor {
  private readonly WINDOW_SIZE = 20;
  private readonly ALERT_THRESHOLD = 0.6;
  private readonly MIN_SAMPLES_FOR_ALERT = 8;
  private readonly ALERT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  async record(record: HealthRecord): Promise<void> {
    // Guard: when the extension context is invalidated (SW restart, reload,
    // update) chrome.runtime.id is undefined and any chrome.* call throws.
    // Skip silently — there is nothing to persist into a dead context.
    if (!chrome.runtime?.id) return;
    try {
      const existing = await this.getHistory(record.platform);
      const updated = [...existing, record].slice(-this.WINDOW_SIZE);
      await chrome.storage.local.set({ [`health_${record.platform}`]: updated });
      await this.checkHealth(record.platform, updated);
    } catch (e) {
      // "Extension context invalidated" is expected during SW restart — not an
      // error worth surfacing. Only warn on genuinely unexpected failures.
      if (e instanceof Error && /context invalidated|Extension context/i.test(e.message)) return;
      console.warn(`[CM:health] record failed:`, e);
    }
  }

  async getHistory(platform: string): Promise<HealthRecord[]> {
    try {
      const result = await chrome.storage.local.get(`health_${platform}`);
      return (result[`health_${platform}`] as HealthRecord[]) ?? [];
    } catch {
      return [];
    }
  }

  private async checkHealth(
    platform: string,
    history: HealthRecord[]
  ): Promise<void> {
    if (history.length < this.MIN_SAMPLES_FOR_ALERT) return;

    const successRate =
      history.filter((r) => r.success).length / history.length;
    const assistantRate =
      history.filter((r) => r.assistantCount > 0).length / history.length;

    console.log(
      `[CM:health] ${platform}: success=${(successRate * 100).toFixed(0)}% assistant=${(assistantRate * 100).toFixed(0)}%`
    );

    // Only alert if success rate is bad AND assistant detection is also failing
    // This prevents false alarms during rapid session switching where old sessions
    // briefly show 0 messages while new page loads
    const isRealFailure = successRate < this.ALERT_THRESHOLD && assistantRate < 0.5;
    if (isRealFailure) {
      console.warn(
        `[CM:health] ${platform} capture rate ${(successRate * 100).toFixed(0)}% (assistants ${(assistantRate * 100).toFixed(0)}%) — selectors may need check`
      );
      const alert: CaptureAlert = {
        platform,
        successRate,
        timestamp: Date.now(),
        message: `Capture quality dropped on ${platform}. Some messages may be missing.`,
      };
      await chrome.storage.local.set({ [`alert_${platform}`]: alert });
    } else {
      // Rate has recovered — clear any existing alert immediately.
      await chrome.storage.local.remove(`alert_${platform}`);
    }
  }

  async getAlerts(): Promise<Record<string, CaptureAlert>> {
    const platforms: string[] = [
      "claude",
      "chatgpt",
      "gemini",
      "grok",
      "deepseek",
      "perplexity",
    ];
    const keys = platforms.map((p) => `alert_${p}`);
    try {
      const raw = await chrome.storage.local.get(keys);
      const now = Date.now();
      const result: Record<string, CaptureAlert> = {};
      for (const [key, val] of Object.entries(raw)) {
        const alert = val as CaptureAlert;
        if (alert && now - alert.timestamp < this.ALERT_TTL_MS) {
          result[key] = alert;
        } else if (alert) {
          // auto-clear expired alert
          void chrome.storage.local.remove(key);
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  async clearAlert(platform: string): Promise<void> {
    try {
      await chrome.storage.local.remove(`alert_${platform}`);
    } catch { /* ignore */ }
  }
}

export const healthMonitor = new CaptureHealthMonitor();
