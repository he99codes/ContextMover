// packages/browser-extension/src/content/floating-bubble/bubble.ts
// Floating bubble UI — injected into all 6 AI platforms.
// Isolated via Shadow DOM so page CSS never bleeds in.
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { BubblePanel } from "./BubblePanel";
import bubbleCss from "./bubble.css?inline";

// ── Types ──────────────────────────────────────────────────────────────────────
type BubbleStatus = "idle" | "capturing" | "error";
type SnapZone = "top-right" | "bottom-right" | "top-left" | "bottom-left";

interface BubbleConfig {
  enabled: boolean;
  size: "small" | "normal" | "large";
  opacity: number;
  snap: SnapZone;
  position: { x: number; y: number };
}

const SIZES = { small: 40, normal: 48, large: 56 } as const;
const GUARD  = "__cf_bubble_v1";
const w = window as unknown as Record<string, unknown>;

// ── Guard: prevent duplicate injection ────────────────────────────────────────
if (!w[GUARD]) {
  w[GUARD] = true;
  const schedule = typeof requestIdleCallback !== "undefined"
    ? (fn: () => void) => requestIdleCallback(fn, { timeout: 2000 })
    : (fn: () => void) => setTimeout(fn, 600);
  schedule(() => void initBubble());
}

// ── Config helpers ─────────────────────────────────────────────────────────────
async function loadConfig(): Promise<BubbleConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["bubbleEnabled", "bubbleSize", "bubbleOpacity", "bubbleSnap", "bubblePosition"],
      (r) => resolve({
        enabled:  r.bubbleEnabled  !== false,
        size:     (r.bubbleSize    as BubbleConfig["size"])     ?? "normal",
        opacity:  typeof r.bubbleOpacity === "number" ? r.bubbleOpacity : 0.85,
        snap:     (r.bubbleSnap    as SnapZone) ?? "bottom-right",
        position: (r.bubblePosition as { x: number; y: number }) ?? { x: 24, y: 24 },
      })
    );
  });
}

function saveConfig(patch: Partial<{
  bubbleEnabled: boolean;
  bubbleSnap: SnapZone;
  bubblePosition: { x: number; y: number };
}>) {
  chrome.storage.local.set(patch);
}

// ── Main init ──────────────────────────────────────────────────────────────────
async function initBubble() {
  const cfg = await loadConfig();
  if (!cfg.enabled) return;

  // Host sits at <html> level — survives SPA body-swaps.
  const host = document.createElement("div");
  host.id = "cf-bubble-host";
  Object.assign(host.style, {
    position:      "fixed",
    zIndex:        "2147483647",
    top:           "0",
    left:          "0",
    width:         "0",
    height:        "0",
    overflow:      "visible",
    pointerEvents: "none",
  });
  (document.documentElement ?? document.body).appendChild(host);

  // Shadow DOM for complete style isolation.
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = bubbleCss;
  shadow.appendChild(styleEl);

  // ── Bubble circle ──────────────────────────────────────────────────────
  const bubble = document.createElement("div");
  bubble.className = "cf-bubble";
  bubble.setAttribute("role", "button");
  bubble.setAttribute("aria-label", "ContextForge — open panel");
  bubble.tabIndex = 0;
  shadow.appendChild(bubble);

  // ── Panel mount point ──────────────────────────────────────────────────
  const panelWrap = document.createElement("div");
  panelWrap.className = "cf-panel-wrap";
  panelWrap.style.display = "none";
  shadow.appendChild(panelWrap);

  // ── Apply initial config ───────────────────────────────────────────────
  const sizePx = SIZES[cfg.size];
  bubble.style.width   = `${sizePx}px`;
  bubble.style.height  = `${sizePx}px`;
  bubble.style.opacity = String(cfg.opacity);
  applySnapPos(bubble, cfg.snap, cfg.position);
  addSnapClass(bubble, cfg.snap);
  renderDot(bubble, "idle");

  // ── State ──────────────────────────────────────────────────────────────
  let captureStatus: BubbleStatus = "idle";
  let expanded  = false;
  let currentSnap = cfg.snap;
  let panelRoot: Root | null = null;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Drag ───────────────────────────────────────────────────────────────
  let dragging = false;
  let ptrStartX = 0, ptrStartY = 0;
  let bubStartX = 0, bubStartY = 0;

  bubble.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = false;
    ptrStartX = e.clientX;
    ptrStartY = e.clientY;
    const r = bubble.getBoundingClientRect();
    bubStartX = r.left;
    bubStartY = r.top;
    // Normalise to absolute left/top so we can offset freely during drag.
    Object.assign(bubble.style, { left: `${r.left}px`, top: `${r.top}px`, right: "auto", bottom: "auto" });
    bubble.setPointerCapture(e.pointerId);
    host.style.pointerEvents = "auto";
  });

  bubble.addEventListener("pointermove", (e: PointerEvent) => {
    const dx = e.clientX - ptrStartX;
    const dy = e.clientY - ptrStartY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      dragging = true;
      bubble.classList.add("cf-bubble--dragging");
    }
    const nx = Math.max(8, Math.min(window.innerWidth  - sizePx - 8, bubStartX + dx));
    const ny = Math.max(8, Math.min(window.innerHeight - sizePx - 8, bubStartY + dy));
    Object.assign(bubble.style, { left: `${nx}px`, top: `${ny}px` });
  });

  bubble.addEventListener("pointerup", (e: PointerEvent) => {
    bubble.releasePointerCapture(e.pointerId);
    host.style.pointerEvents = "none";
    bubble.classList.remove("cf-bubble--dragging");

    if (dragging) {
      dragging = false;
      const r  = bubble.getBoundingClientRect();
      const cx = r.left + sizePx / 2;
      const cy = r.top  + sizePx / 2;
      const snapRight  = cx > window.innerWidth  / 2;
      const snapBottom = cy > window.innerHeight / 2;
      currentSnap = `${snapBottom ? "bottom" : "top"}-${snapRight ? "right" : "left"}` as SnapZone;
      const sx = snapRight  ? Math.max(8, window.innerWidth  - r.right) : Math.max(8, r.left);
      const sy = snapBottom ? Math.max(8, window.innerHeight - r.bottom) : Math.max(8, r.top);
      applySnapPos(bubble, currentSnap, { x: sx, y: sy });
      addSnapClass(bubble, currentSnap);
      saveConfig({ bubbleSnap: currentSnap, bubblePosition: { x: sx, y: sy } });
    } else {
      // Pure click — toggle panel.
      expanded ? collapsePanel() : expandPanel();
    }
  });

  // Keyboard accessibility.
  bubble.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expanded ? collapsePanel() : expandPanel(); }
  });

  // ── Expand / Collapse ──────────────────────────────────────────────────
  function expandPanel() {
    expanded = true;
    bubble.style.display = "none";
    panelWrap.style.display = "block";
    host.style.pointerEvents = "auto";
    applyPanelPos(panelWrap, currentSnap);
    mountPanel();
  }

  function collapsePanel() {
    expanded = false;
    panelWrap.style.display = "none";
    bubble.style.display    = "";
    host.style.pointerEvents = "none";
  }

  function mountPanel() {
    if (!panelRoot) panelRoot = createRoot(panelWrap);
    panelRoot.render(
      React.createElement(BubblePanel, {
        captureStatus,
        snapZone: currentSnap,
        onMinimize: collapsePanel,
        onClose: collapsePanel,
      })
    );
  }

  // ── Capture status from SW ─────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg: { type: string; status?: string }) => {
    if (msg.type !== "BUBBLE_STATUS_UPDATE") return;
    const next = (msg.status ?? "idle") as BubbleStatus;
    captureStatus = next;
    renderDot(bubble, next);
    if (next === "capturing") {
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => {
        captureStatus = "idle";
        renderDot(bubble, "idle");
        pulseTimer = null;
      }, 3000);
    }
    if (expanded && panelRoot) mountPanel();
  });

  // ── SPA navigation: close open panel on URL change ────────────────────
  window.addEventListener("popstate", () => { if (expanded) collapsePanel(); });
  const _origPush = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    _origPush(...args);
    if (expanded) collapsePanel();
  };

  // ── Settings hot-reload ────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.bubbleEnabled?.newValue === false) host.remove();
    if (changes.bubbleOpacity?.newValue !== undefined) {
      bubble.style.opacity = String(changes.bubbleOpacity.newValue);
    }
    if (changes.bubbleSize?.newValue !== undefined) {
      const s = SIZES[changes.bubbleSize.newValue as BubbleConfig["size"]] ?? 48;
      bubble.style.width  = `${s}px`;
      bubble.style.height = `${s}px`;
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderDot(bubble: HTMLElement, status: BubbleStatus) {
  const dotCls = status === "capturing"
    ? "cf-dot cf-dot--active cf-dot--pulse"
    : status === "error"
    ? "cf-dot cf-dot--error"
    : "cf-dot cf-dot--idle";
  const label  = status === "capturing" ? "Capturing…" : status === "error" ? "Error" : "Ready";
  bubble.innerHTML = `
    <div class="cf-bubble-inner">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 2L3 6.5V13.5L10 18L17 13.5V6.5L10 2Z" fill="#00D26A" opacity="0.9"/>
        <path d="M10 5.5L5.5 8V12L10 14.5L14.5 12V8L10 5.5Z" fill="#0A0A0A"/>
        <circle cx="10" cy="10" r="2.2" fill="#00D26A"/>
      </svg>
      <span class="${dotCls}" aria-label="${label}"></span>
    </div>
    <div class="cf-tooltip" aria-hidden="true">
      <span class="cf-tooltip-name">ContextForge</span>
      <span class="cf-tooltip-status">${label}</span>
    </div>`;
}

function applySnapPos(el: HTMLElement, snap: SnapZone, pos: { x: number; y: number }) {
  const r = snap.includes("right");
  const b = snap.includes("bottom");
  Object.assign(el.style, {
    position: "fixed",
    left:     r ? "auto" : `${pos.x}px`,
    right:    r ? `${pos.x}px` : "auto",
    top:      b ? "auto" : `${pos.y}px`,
    bottom:   b ? `${pos.y}px` : "auto",
  });
}

function addSnapClass(el: HTMLElement, snap: SnapZone) {
  el.classList.remove("cf-snap-left", "cf-snap-right", "cf-snap-top", "cf-snap-bottom");
  el.classList.add(snap.includes("right") ? "cf-snap-right" : "cf-snap-left");
  el.classList.add(snap.includes("bottom") ? "cf-snap-bottom" : "cf-snap-top");
}

function applyPanelPos(panel: HTMLElement, snap: SnapZone) {
  const r = snap.includes("right");
  const b = snap.includes("bottom");
  Object.assign(panel.style, {
    position: "fixed",
    right:    r ? "16px" : "auto",
    left:     r ? "auto" : "16px",
    bottom:   b ? "16px" : "auto",
    top:      b ? "auto" : "16px",
  });
}
