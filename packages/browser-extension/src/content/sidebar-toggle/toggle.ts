/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import css from "./toggle.css?inline";
import logoUrl from "../../assets/logo.png?url";

const GUARD = "__cm_toggle_v2";
const w = window as unknown as Record<string, unknown>;
if (!w[GUARD]) { w[GUARD] = true; init(); }

type TogglePosition = { side: "left" | "right"; top: number };

function init(): void {
  let isOpen = false;
  let busy = false;
  let currentShadow: ShadowRoot | null = null;
  
  let position: TogglePosition = { side: "right", top: 72 };
  let isDragging = false;
  let dragThresholdMet = false;

  // Load position
  chrome.storage.local.get("cm_toggle_position", (res) => {
    if (res.cm_toggle_position) {
      position = res.cm_toggle_position;
      applyPosition();
    }
  });

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
      const btn = currentShadow.querySelector('.cf-toggle');
      if (btn) {
        btn.classList.toggle("cf-toggle--left", position.side === "left");
      }
    }
  }

  function updateBtn(): void {
    if (!currentShadow) return;
    const btn = currentShadow.querySelector<HTMLButtonElement>('.cf-toggle');
    if (!btn) return;
    btn.classList.toggle("cf-toggle--open", isOpen);
    btn.classList.toggle("cf-toggle--busy",  busy);
  }

  function syncState(): void {
    chrome.runtime.sendMessage(
      { type: "GET_SIDEBAR_STATE" },
      (res) => {
        if (chrome.runtime.lastError) return;
        isOpen = res?.isOpen ?? false;
        updateBtn();
      }
    );
  }

  chrome.runtime.onMessage.addListener((msg: { type: string; status?: string }) => {
    if (msg.type === "CAPTURE_STATUS_UPDATE") {
      if (!currentShadow) return;
      const dot = currentShadow.querySelector(".cf-dot");
      if (!dot) return;
      dot.className = `cf-dot cf-dot--${msg.status === "capturing" ? "active" : "idle"}`;
    }
    if (msg.type === "SIDEBAR_CLOSED") {
      busy = false;
      isOpen = false;
      updateBtn();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncState();
  }, { passive: true });

  function ensureInjected(): void {
    const existing = document.getElementById("cm-toggle-host");
    if (existing?.isConnected) return;
    inject();
  }

  function inject(): void {
    document.getElementById("cm-toggle-host")?.remove();

    const host = document.createElement("div");
    host.id = "cm-toggle-host";
    const s = host.style;
    s.setProperty("position",       "fixed",      "important");
    s.setProperty("display",        "block",      "important");
    s.setProperty("width",          "48px",       "important");
    s.setProperty("height",         "48px",       "important");
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
    btn.innerHTML = `
      <img src="${logoUrl}" alt="ContextMover" style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block;pointer-events:none;" aria-hidden="true" />
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
        const maxTop = window.innerHeight - 48; // Button height is 48px
        newTop = Math.max(0, Math.min(newTop, maxTop));
        position.top = newTop;

        const halfWidth = window.innerWidth / 2;
        if (clientX < halfWidth) {
          position.side = "left";
        } else {
          position.side = "right";
        }

        applyPosition();
      }
    }

    function dragEnd(e: MouseEvent | TouchEvent) {
      isDragging = false;
      window.removeEventListener("mousemove", dragMove, true);
      window.removeEventListener("mouseup", dragEnd, true);
      window.removeEventListener("touchmove", dragMove, true);
      window.removeEventListener("touchend", dragEnd, true);

      btn.style.transition = "";

      if (dragThresholdMet) {
        chrome.storage.local.set({ cm_toggle_position: position });
      }
    }

    btn.addEventListener("mousedown", dragStart);
    btn.addEventListener("touchstart", dragStart, { passive: false });

    // ── Click Logic ────────────────────────────────────────────────────────────
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (dragThresholdMet) return; // Ignore click if we dragged
      if (busy) return;
      busy = true;
      updateBtn();

      isOpen = !isOpen;
      updateBtn();

      const safetyTimer = setTimeout(() => {
        busy = false;
        updateBtn();
      }, 2000);

      chrome.runtime.sendMessage(
        { type: "TOGGLE_SIDEBAR", shouldOpen: isOpen },
        (res) => {
          clearTimeout(safetyTimer);
          if (chrome.runtime.lastError) {
            console.warn("[CM:toggle] SW sleeping, retrying...");
            setTimeout(() => {
              chrome.runtime.sendMessage(
                { type: "TOGGLE_SIDEBAR", shouldOpen: isOpen },
                (retryRes) => {
                  busy = false;
                  if (chrome.runtime.lastError) {
                    isOpen = !isOpen;
                    updateBtn();
                    return;
                  }
                  isOpen = retryRes?.isOpen ?? isOpen;
                  updateBtn();
                }
              );
            }, 150);
            return;
          }
          busy = false;
          isOpen = res?.isOpen ?? isOpen;
          updateBtn();
        }
      );
    });
  }

  ensureInjected();
  window.addEventListener("popstate", ensureInjected);

  const _push = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    _push(...args);
    setTimeout(ensureInjected, 100);
  };
}
