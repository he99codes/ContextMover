/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Proprietary and confidential.
 */

// src/sidebar/SelfHealWizard.tsx
// 3-step self-healing wizard for fixing broken platform scrapers.
// Step 1: Select platform → auto-run DOM probe on the active tab (no DevTools needed).
//         Falls back to copy/paste if auto-probe fails.
// Step 2: Auto-selected best selectors shown for confirmation — no manual picking.
// Step 3: Apply overrides to chrome.storage.local, optionally share with server.

import React, { useState, useRef, useCallback, useEffect } from "react";
import { generateProbeScript, type Platform, type ProbeCandidate, type ProbeResult } from "@/lib/self-heal/probe-scripts";
import { saveOverridesForPlatform, shareOverrideWithServer } from "@/lib/self-heal/selector-overrides";

const PLATFORMS: Platform[] = ["gemini", "chatgpt", "claude", "grok", "deepseek", "perplexity"];
const PLATFORM_LABELS: Record<Platform, string> = {
  gemini: "Gemini", chatgpt: "ChatGPT", claude: "Claude",
  grok: "Grok", deepseek: "DeepSeek", perplexity: "Perplexity",
};

const PLATFORM_DOMAINS: Record<Platform, string> = {
  gemini: "gemini.google.com", chatgpt: "chatgpt.com",
  claude: "claude.ai", grok: "grok.com",
  deepseek: "chat.deepseek.com", perplexity: "perplexity.ai",
};

type WizardStep = 1 | 2 | 3;

interface ConfirmedSelectors {
  userSelector?: string;
  assistantSelector?: string;
  rootSelector?: string;
  inputSelector?: string;
}

interface Props {
  initialPlatform?: Platform;
  onClose: () => void;
  accessToken?: string | null;
}

function pickBest(candidates: ProbeCandidate[], role: ProbeCandidate["role"]): ProbeCandidate | undefined {
  return candidates
    .filter(c => c.role === role)
    .sort((a, b) => b.confidence - a.confidence || b.count - a.count)[0];
}

function buildAutoSelected(candidates: ProbeCandidate[]): ConfirmedSelectors {
  return {
    userSelector: pickBest(candidates, "user")?.selector,
    assistantSelector: pickBest(candidates, "assistant")?.selector,
    rootSelector: pickBest(candidates, "root")?.selector,
    inputSelector: pickBest(candidates, "input")?.selector,
  };
}

export default function SelfHealWizard({ initialPlatform, onClose, accessToken }: Props) {
  const [step, setStep] = useState<WizardStep>(1);
  const [platform, setPlatform] = useState<Platform>(initialPlatform ?? "gemini");
  const [probing, setProbing] = useState(false);
  const [probeStatus, setProbeStatus] = useState<string>("");
  const [showFallback, setShowFallback] = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [probeJson, setProbeJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [autoSelected, setAutoSelected] = useState<ConfirmedSelectors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const probeScript = generateProbeScript(platform);

  // ── Auto-run probe via content script message ────────────────────────────────
  const runAutoProbe = useCallback(async () => {
    setProbing(true);
    setProbeStatus("Looking for open tab…");
    setShowFallback(false);
    setParseError(null);
    try {
      // Find a tab matching the platform domain
      const domain = PLATFORM_DOMAINS[platform];
      const tabs = await chrome.tabs.query({});
      const target = tabs.find(t => t.url && t.url.includes(domain));
      if (!target?.id) {
        setProbeStatus("");
        setShowFallback(true);
        setProbing(false);
        return;
      }
      setProbeStatus(`Probing ${PLATFORM_LABELS[platform]} tab…`);
      const response = await chrome.runtime.sendMessage({
        type: "RUN_DOM_PROBE",
        tabId: target.id,
      });
      if (response?.ok && response.probeResult?.candidates) {
        const candidates: ProbeCandidate[] = response.probeResult.candidates;
        const result: ProbeResult = {
          platform,
          url: response.probeResult.url ?? "",
          timestamp: response.probeResult.timestamp ?? Date.now(),
          candidates,
          rawDump: "",
        };
        setProbeResult(result);
        setAutoSelected(buildAutoSelected(candidates));
        setProbeStatus("");
        setTimeout(() => setStep(2), 200);
      } else {
        const err = response?.error ?? "No response from content script";
        setProbeStatus("");
        setShowFallback(true);
        console.warn("[CM:wizard] auto-probe failed:", err);
      }
    } catch (e) {
      setProbeStatus("");
      setShowFallback(true);
      console.warn("[CM:wizard] auto-probe error:", e);
    } finally {
      setProbing(false);
    }
  }, [platform]);

  // ── Auto-run immediately when platform is set (if not already on fallback) ──
  useEffect(() => {
    if (step === 1 && !showFallback) {
      runAutoProbe();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // ── Fallback: auto-parse JSON as user pastes ─────────────────────────────────
  useEffect(() => {
    if (!probeJson.trim()) { setParseError(null); return; }
    try {
      const parsed = JSON.parse(probeJson.trim()) as ProbeResult;
      if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
        setParseError("No 'candidates' array — make sure you copied the full JSON output");
        return;
      }
      setParseError(null);
      setProbeResult(parsed);
      setAutoSelected(buildAutoSelected(parsed.candidates));
      setTimeout(() => setStep(2), 350);
    } catch {
      setParseError(null);
    }
  }, [probeJson]);

  // ── Copy fallback script ─────────────────────────────────────────────────────
  const copyScript = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(probeScript);
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 2500);
    } catch {
      if (textareaRef.current) {
        textareaRef.current.select();
        document.execCommand("copy");
        setScriptCopied(true);
        setTimeout(() => setScriptCopied(false), 2500);
      }
    }
  }, [probeScript]);

  // ── Step 2 → 3: apply ───────────────────────────────────────────────────────
  const applySelectors = useCallback(async () => {
    setSaving(true);
    try {
      await saveOverridesForPlatform(platform, autoSelected);
      setSaved(true);
      setStep(3);
    } catch (e) {
      console.error("[CM:self-heal] save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [platform, autoSelected]);

  const shareWithServer = useCallback(async () => {
    if (!accessToken) {
      setShareResult({ ok: false, error: "Not signed in — sign in via the sidebar to share fixes." });
      return;
    }
    setSharing(true);
    const result = await shareOverrideWithServer(platform, { ...autoSelected, savedAt: Date.now() }, accessToken);
    setShareResult(result);
    setSharing(false);
  }, [platform, autoSelected, accessToken]);

  // ── Styles ───────────────────────────────────────────────────────────────────
  const bg = { background: "#060D06", color: "#C8E6C9", fontFamily: "monospace" };
  const panelBg = { background: "rgba(0,255,136,0.03)", border: "1px solid rgba(0,255,136,0.12)", borderRadius: 6 };
  const btn = (active?: boolean): React.CSSProperties => ({
    background: active ? "rgba(0,255,136,0.15)" : "rgba(0,255,136,0.06)",
    border: `1px solid ${active ? "rgba(0,255,136,0.5)" : "rgba(0,255,136,0.18)"}`,
    color: "#00FF88", borderRadius: 5, padding: "5px 12px", cursor: "pointer",
    fontSize: 11, fontFamily: "monospace", fontWeight: 600,
  });
  const inputStyle: React.CSSProperties = {
    background: "rgba(0,0,0,0.4)", border: "1px solid rgba(0,255,136,0.2)",
    borderRadius: 4, color: "#C8E6C9", fontSize: 10, fontFamily: "monospace",
    padding: "4px 8px", width: "100%", boxSizing: "border-box",
  };
  const stepDot = (s: WizardStep): React.CSSProperties => ({
    width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: 10, fontWeight: 700,
    background: step === s ? "rgba(0,255,136,0.2)" : step > s ? "rgba(0,255,136,0.08)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${step === s ? "rgba(0,255,136,0.7)" : step > s ? "rgba(0,255,136,0.3)" : "rgba(255,255,255,0.1)"}`,
    color: step >= s ? "#00FF88" : "#555",
  });
  const confidenceColor = (c: number) => c >= 0.8 ? "#00FF88" : c >= 0.6 ? "#FFAA00" : "#FF6B6B";
  const confidenceLabel = (c: number) => c >= 0.8 ? "High" : c >= 0.6 ? "Medium" : "Low";

  return (
    <div style={{ ...bg, position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid rgba(0,255,136,0.1)" }}>
        <span style={{ fontSize: 13, color: "#00FF88", fontWeight: 700 }}>🔧 Self-Heal Scraper</span>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {([1, 2, 3] as WizardStep[]).map(s => (
            <React.Fragment key={s}>
              <div style={stepDot(s)}>{step > s ? "✓" : s}</div>
              {s < 3 && <div style={{ width: 18, height: 1, background: step > s ? "rgba(0,255,136,0.3)" : "rgba(255,255,255,0.07)" }} />}
            </React.Fragment>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16, padding: "0 4px" }}>×</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>

        {/* ── STEP 1 ─────────────────────────────────────────────────────────── */}
        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 11, color: "#00FF88", fontWeight: 700 }}>Step 1 — Run DOM Probe</div>

            {/* Platform picker */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {PLATFORMS.map(p => (
                <button key={p} style={btn(platform === p)} onClick={() => {
                  setPlatform(p);
                  setShowFallback(false);
                  setProbeJson("");
                  setParseError(null);
                  setProbeResult(null);
                }}>
                  {PLATFORM_LABELS[p]}
                </button>
              ))}
            </div>

            {/* Auto-probe status */}
            {probing && (
              <div style={{ ...panelBg, padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16, animation: "spin 1s linear infinite" }}>⟳</span>
                <span style={{ fontSize: 10, color: "#8aaa8a" }}>{probeStatus || "Running probe…"}</span>
              </div>
            )}

            {/* Not probing, no fallback — show retry */}
            {!probing && !showFallback && !probeResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 10, color: "#8aaa8a", lineHeight: 1.6 }}>
                  Make sure the {PLATFORM_LABELS[platform]} tab is open, then click Run Probe.
                  The probe runs automatically — no DevTools needed.
                </div>
                <button onClick={runAutoProbe} style={btn(true)}>Run Probe →</button>
              </div>
            )}

            {/* Fallback — auto-probe failed (no tab open or content script not ready) */}
            {!probing && showFallback && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ ...panelBg, padding: "8px 12px", fontSize: 10, color: "#FFAA00", lineHeight: 1.6 }}>
                  ⚠ Auto-probe couldn't reach the {PLATFORM_LABELS[platform]} tab.
                  Make sure the page is open and loaded, then try again — or use the manual fallback below.
                </div>
                <button onClick={runAutoProbe} disabled={probing} style={btn(true)}>↺ Try Again</button>
                <div style={{ fontSize: 10, color: "#555", textAlign: "center" }}>— or manually paste probe output —</div>
                {/* Manual fallback */}
                <div style={{ ...panelBg, position: "relative" }}>
                  <textarea
                    ref={textareaRef}
                    readOnly
                    value={probeScript}
                    style={{ ...inputStyle, height: 110, resize: "none", fontSize: 9, lineHeight: 1.5, border: "none", background: "transparent" }}
                  />
                  <button onClick={copyScript} style={{ ...btn(scriptCopied), position: "absolute", top: 6, right: 6, fontSize: 10 }}>
                    {scriptCopied ? "✓ Copied!" : "Copy Script"}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: "#8aaa8a" }}>Paste the probe output here — wizard advances automatically:</div>
                <textarea
                  placeholder='{"platform":"claude","candidates":[...],...}'
                  value={probeJson}
                  onChange={e => setProbeJson(e.target.value)}
                  style={{ ...inputStyle, height: 70, resize: "vertical" }}
                />
                {parseError && <div style={{ fontSize: 9, color: "#FF6B6B" }}>{parseError}</div>}
              </div>
            )}

            <button onClick={onClose} style={{ ...btn(), color: "#666", alignSelf: "flex-start" }}>Cancel</button>
          </div>
        )}

        {/* ── STEP 2 ─────────────────────────────────────────────────────────── */}
        {step === 2 && probeResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 11, color: "#00FF88", fontWeight: 700 }}>Step 2 — Review Auto-Selected Selectors</div>
            <div style={{ fontSize: 10, color: "#8aaa8a", lineHeight: 1.6 }}>
              The probe analysed the page and picked the best selector for each role automatically.
              Review the results below, then click Apply to save them.
            </div>

            {(["user", "assistant", "root", "input"] as const).map(role => {
              const key = `${role}Selector` as keyof ConfirmedSelectors;
              const best = pickBest(probeResult.candidates, role as ProbeCandidate["role"]);
              const sel = autoSelected[key];
              return (
                <div key={role} style={{ ...panelBg, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: "#00FF88", fontWeight: 600, textTransform: "capitalize", minWidth: 70 }}>
                      {role}
                    </span>
                    {best ? (
                      <span style={{ fontSize: 8, color: confidenceColor(best.confidence), marginLeft: "auto", flexShrink: 0 }}>
                        {confidenceLabel(best.confidence)} confidence · {best.count} match{best.count !== 1 ? "es" : ""}
                      </span>
                    ) : (
                      <span style={{ fontSize: 8, color: "#555", marginLeft: "auto" }}>not found</span>
                    )}
                  </div>
                  {sel ? (
                    <>
                      <div style={{ fontSize: 9, color: "#C8E6C9", fontFamily: "monospace", background: "rgba(0,0,0,0.3)", borderRadius: 3, padding: "3px 6px" }}>
                        {sel}
                      </div>
                      {best?.sample && (
                        <div style={{ fontSize: 8, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          Sample: {best.sample.slice(0, 80)}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize: 9, color: "#444", fontStyle: "italic" }}>No selector found — will skip this role</div>
                  )}
                </div>
              );
            })}

            {autoSelected.userSelector || autoSelected.assistantSelector ? (
              <div style={{ fontSize: 9, color: "#00FF88", background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 4, padding: "6px 10px" }}>
                ✓ Ready to apply — {[autoSelected.userSelector && "user", autoSelected.assistantSelector && "assistant", autoSelected.rootSelector && "root", autoSelected.inputSelector && "input"].filter(Boolean).join(", ")} selector{Object.values(autoSelected).filter(Boolean).length !== 1 ? "s" : ""} found
              </div>
            ) : (
              <div style={{ fontSize: 9, color: "#FF6B6B", background: "rgba(255,107,107,0.05)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: 4, padding: "6px 10px" }}>
                ⚠ No message selectors found — the page may not have a conversation loaded yet.
                Go back, open a conversation, then re-run.
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setStep(1); setProbeJson(""); setProbeResult(null); setShowFallback(false); }} style={{ ...btn(), color: "#666" }}>← Back</button>
              <button
                onClick={applySelectors}
                disabled={saving || (!autoSelected.userSelector && !autoSelected.assistantSelector)}
                style={{ ...btn(true), opacity: (!autoSelected.userSelector && !autoSelected.assistantSelector) ? 0.4 : 1 }}
              >
                {saving ? "Saving…" : "Apply & Save →"}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3 ─────────────────────────────────────────────────────────── */}
        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 11, color: "#00FF88", fontWeight: 700 }}>Step 3 — Done ✓</div>

            {saved && (
              <div style={{ ...panelBg, padding: "10px 12px", fontSize: 10, lineHeight: 1.7 }}>
                <div style={{ color: "#00FF88", fontWeight: 600, marginBottom: 4 }}>✓ Selectors saved locally</div>
                <div style={{ color: "#8aaa8a" }}>
                  The new selectors are active on this device. Reload the platform tab to verify captures are working.
                </div>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                  {(["userSelector", "assistantSelector", "rootSelector", "inputSelector"] as const).map(k => autoSelected[k] && (
                    <div key={k} style={{ fontSize: 9, color: "#555" }}>
                      <span style={{ color: "#7aaa7a" }}>{k}:</span> {autoSelected[k]}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ ...panelBg, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: "#FFAA00", fontWeight: 600, marginBottom: 4 }}>🌐 Help other users — share this fix</div>
              <div style={{ fontSize: 9, color: "#8aaa8a", lineHeight: 1.6, marginBottom: 8 }}>
                Submitting shares the fix so we can push it to all users via remote config. Only selectors and platform are sent.
              </div>
              {shareResult ? (
                shareResult.ok ? (
                  <div style={{ fontSize: 10, color: "#00FF88" }}>✓ Submitted — thank you! We'll review and roll it out shortly.</div>
                ) : (
                  <div style={{ fontSize: 9, color: "#FF6B6B" }}>Failed: {shareResult.error}</div>
                )
              ) : (
                <button onClick={shareWithServer} disabled={sharing} style={btn()}>
                  {sharing ? "Submitting…" : "Share Fix with All Users"}
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} style={btn(true)}>Done</button>
              <button
                onClick={() => { setStep(1); setProbeJson(""); setProbeResult(null); setAutoSelected({}); setSaved(false); setShareResult(null); setShowFallback(false); }}
                style={{ ...btn(), color: "#666" }}
              >
                Fix Another Platform
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
