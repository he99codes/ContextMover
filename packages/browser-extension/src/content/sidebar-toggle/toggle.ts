/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import css from "./toggle.css?inline";
import logoUrl from "../../assets/logo.png?url";

// ─── Guard: prevent double-init (both LLM-specific and all_urls entries
// run on LLM pages — the first one wins via this guard). ───────────────────────
const GUARD = "__cm_toggle_v3";
const w = window as unknown as Record<string, unknown>;
if (w[GUARD]) { /* already initialised — do nothing */ }
else {
  w[GUARD] = true;
  const LLM_RE = /(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|grok\.com|grok\.x\.ai|www\.perplexity\.ai|chat\.deepseek\.com)$/i;
  init(LLM_RE.test(location.hostname));
}

type TogglePosition = { side: "left" | "right"; top: number };

function init(isLLMTab: boolean): void {
  let isOpen = false;
  let busy = false;
  let currentShadow: ShadowRoot | null = null;

  let position: TogglePosition = { side: "right", top: 72 };
  let isDragging = false;
  let dragThresholdMet = false;

  // Load persisted position
  try {
    chrome.storage.local.get("cm_toggle_position", (res) => {
      if (chrome.runtime.lastError) return;
      if (res.cm_toggle_position) {
        position = res.cm_toggle_position;
        applyPosition();
      }
    });
  } catch { /* Extension context invalidated */ }

  // ── Position helpers ────────────────────────────────────────────────────────

  function applyPosition() {
    const host = document.getElementById("cm-toggle-host");
    if (!host) return;
    const s = host.style;
    s.setProperty("top", `${position.top}px`, "important");
    if (position.side === "left") {
      s.setProperty("left", "0", "important");
      s.setProperty("right", "auto", "important");
    } else {
      s.setProperty("right", "0", "important");
      s.setProperty("left", "auto", "important");
    }

    if (currentShadow) {
      const btn = currentShadow.querySelector(".cf-toggle");
      if (btn) btn.classList.toggle("cf-toggle--left", position.side === "left");
    }
  }

  // ── Button state helpers ────────────────────────────────────────────────────

  function updateBtn(): void {
    if (!currentShadow) return;
    const btn = currentShadow.querySelector<HTMLButtonElement>(".cf-toggle");
    if (!btn) return;
    btn.classList.toggle("cf-toggle--open", isOpen);
    btn.classList.toggle("cf-toggle--busy", busy);
    btn.setAttribute(
      "aria-label",
      isOpen ? "Close ContextMover sidebar" : "Open ContextMover sidebar"
    );
    btn.title = isOpen ? "Close ContextMover" : "Open ContextMover";
  }

  // ── Visibility: LLM tabs always show; non-LLM only when sidebar is open ────

  function updateVisibility(): void {
    if (isLLMTab) {
      ensureInjected();
    } else {
      // Non-LLM tab: show the button only when sidebar is open (so user can close)
      if (isOpen) {
        ensureInjected();
      } else {
        removeToggleHost();
      }
    }
  }

  function removeToggleHost(): void {
    document.getElementById("cm-toggle-host")?.remove();
    currentShadow = null;
  }

  // ── State sync with service worker ─────────────────────────────────────────

  function syncState(): void {
    try {
      chrome.runtime.sendMessage(
        { type: "GET_SIDEBAR_STATE" },
        (res) => {
          if (chrome.runtime.lastError) return;
          isOpen = res?.isOpen ?? false;
          updateVisibility();
          updateBtn();
        }
      );
    } catch { /* Extension context invalidated */ }
  }

  // ── Message listener ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg: {
    type: string;
    status?: string;
    isOpen?: boolean;
    tabId?: number;
  }) => {
    if (msg.type === "CAPTURE_STATUS_UPDATE") {
      if (!currentShadow) return;
      const dot = currentShadow.querySelector(".cf-dot");
      if (!dot) return;
      dot.className = `cf-dot cf-dot--${msg.status === "capturing" ? "active" : "idle"}`;
    }

    if (msg.type === "SIDEBAR_CLOSED") {
      busy = false;
      isOpen = false;
      updateVisibility(); // removes button on non-LLM tabs
      updateBtn();
    }

    if (msg.type === "SIDEBAR_OPENED") {
      isOpen = msg.isOpen ?? true;
      updateVisibility(); // injects button on non-LLM tabs if needed
      updateBtn();
    }
  });

  // ── Tab visibility debounce ─────────────────────────────────────────────────

  let _visibilityDebounce: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener("visibilitychange", () => {
    if (busy) return;
    if (_visibilityDebounce) clearTimeout(_visibilityDebounce);
    _visibilityDebounce = setTimeout(() => {
      if (!document.hidden) syncState();
      _visibilityDebounce = null;
    }, 200);
  }, { passive: true });

  // ── Throttled ensure-injected ───────────────────────────────────────────────

  let _lastEnsureAt = 0;
  const _ENSURE_THROTTLE_MS = 500;

  function ensureInjected(): void {
    const now = Date.now();
    if (now - _lastEnsureAt < _ENSURE_THROTTLE_MS) return;
    _lastEnsureAt = now;

    const existing = document.getElementById("cm-toggle-host");
    if (existing?.isConnected) return;
    inject();
  }

  // ── DOM injection ───────────────────────────────────────────────────────────

  function inject(): void {
    document.getElementById("cm-toggle-host")?.remove();

    const host = document.createElement("div");
    host.id = "cm-toggle-host";
    const s = host.style;
    s.setProperty("position",       "fixed",      "important");
    s.setProperty("display",        "block",      "important");
    s.setProperty("width",          "52px",       "important");
    s.setProperty("height",         "60px",       "important");
    s.setProperty("overflow",       "visible",    "important");
    s.setProperty("z-index",        "2147483647", "important");
    s.setProperty("pointer-events", "none",       "important");

    (document.documentElement ?? document.body).appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });
    currentShadow = shadow;

    const styleEl = document.createElement("style");
    styleEl.textContent = css;
    shadow.appendChild(styleEl);

    const btn = document.createElement("button");
    btn.className = "cf-toggle";
    btn.setAttribute("aria-label", "Toggle ContextMover sidebar");
    btn.title = "Toggle ContextMover";
    btn.innerHTML = `
      <img src="${logoUrl}" alt="ContextMover" class="cf-logo" aria-hidden="true" />
      <span class="cf-chevron" aria-hidden="true"></span>
      <span class="cf-dot cf-dot--idle" aria-hidden="true"></span>
    `;
    shadow.appendChild(btn);

    applyPosition();
    updateBtn();
    syncState();

    // ── Drag Logic ─────────────────────────────────────────────────────────────

    let startY = 0;
    let startX = 0;
    let startTop = 0;

    function dragStart(e: MouseEvent | TouchEvent) {
      if (e.type === "mousedown" && (e as MouseEvent).button !== 0) return;
      isDragging = true;
      dragThresholdMet = false;

      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;

      startY = clientY;
      startX = clientX;
      startTop = position.top;

      window.addEventListener("mousemove", dragMove, true);
      window.addEventListener("mouseup", dragEnd, true);
      window.addEventListener("touchmove", dragMove, { passive: false, capture: true });
      window.addEventListener("touchend", dragEnd, true);

      btn.style.transition = "none";
    }

    function dragMove(e: MouseEvent | TouchEvent) {
      if (!isDragging) return;

      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;

      const deltaY = clientY - startY;
      const deltaX = clientX - startX;

      if (!dragThresholdMet && (Math.abs(deltaY) > 5 || Math.abs(deltaX) > 5)) {
        dragThresholdMet = true;
      }

      if (dragThresholdMet) {
        if (e.cancelable) e.preventDefault();

        let newTop = startTop + deltaY;
        const maxTop = window.innerHeight - 60;
        newTop = Math.max(0, Math.min(newTop, maxTop));
        position.top = newTop;

        const halfWidth = window.innerWidth / 2;
        position.side = clientX < halfWidth ? "left" : "right";

        applyPosition();
      }
    }

    function dragEnd(_e: MouseEvent | TouchEvent) {
      isDragging = false;
      window.removeEventListener("mousemove", dragMove, true);
      window.removeEventListener("mouseup", dragEnd, true);
      window.removeEventListener("touchmove", dragMove, true);
      window.removeEventListener("touchend", dragEnd, true);

      btn.style.transition = "";

      if (dragThresholdMet) {
        try { chrome.storage.local.set({ cm_toggle_position: position }); } catch { /* ok */ }
      }
    }

    btn.addEventListener("mousedown", dragStart);
    btn.addEventListener("touchstart", dragStart, { passive: false });

    // ── Click Logic ────────────────────────────────────────────────────────────

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (dragThresholdMet) return;
      if (busy) return;
      busy = true;
      updateBtn();

      isOpen = !isOpen;
      updateBtn();

      const safetyTimer = setTimeout(() => {
        busy = false;
        updateBtn();
      }, 3000);

      try {
        chrome.runtime.sendMessage(
          { type: "TOGGLE_SIDEBAR", shouldOpen: isOpen },
          (res) => {
            clearTimeout(safetyTimer);
            if (chrome.runtime.lastError) {
              console.warn("[CM:toggle] SW sleeping, retrying…");
              setTimeout(() => {
                try {
                  chrome.runtime.sendMessage(
                    { type: "TOGGLE_SIDEBAR", shouldOpen: isOpen },
                    (retryRes) => {
                      busy = false;
                      if (chrome.runtime.lastError) {
                        isOpen = !isOpen;
                      } else {
                        isOpen = retryRes?.isOpen ?? isOpen;
                      }
                      updateVisibility();
                      updateBtn();
                    }
                  );
                } catch {
                  busy = false;
                  isOpen = !isOpen;
                  updateVisibility();
                  updateBtn();
                }
              }, 150);
              return;
            }
            busy = false;
            isOpen = res?.isOpen ?? isOpen;
            updateVisibility();
            updateBtn();
          }
        );
      } catch {
        clearTimeout(safetyTimer);
        busy = false;
        isOpen = !isOpen;
        updateVisibility();
        updateBtn();
      }
    });
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────────

  // On LLM tabs: inject immediately (always visible)
  // On non-LLM tabs: syncState first — inject only if sidebar is already open
  if (isLLMTab) {
    ensureInjected();
  }
  syncState();

  // Re-inject on SPA navigation (LLM tab only — non-LLM handled by visibility)
  if (isLLMTab) {
    window.addEventListener("popstate", ensureInjected);

    const _push = history.pushState.bind(history);
    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      _push(...args);
      setTimeout(ensureInjected, 100);
    };

    window.addEventListener("beforeunload", () => {
      history.pushState = _push;
    });
  }
}
