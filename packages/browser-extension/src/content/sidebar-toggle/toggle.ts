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

function init(): void {
  // ── State at init() scope — persists across SPA reinjects ─────────────────
  // Previously these lived inside inject(), so every SPA navigation reset
  // isOpen to false (desync) and registered duplicate listeners.
  let isOpen        = false;
  let busy          = false;
  let currentShadow: ShadowRoot | null = null; // always points to latest shadow

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

  // ── onMessage registered ONCE — not re-registered on each inject ───────────
  // The old code called addListener() inside inject(), accumulating duplicate
  // listeners on every SPA nav (popstate / pushState). Now there is exactly
  // one listener for the lifetime of the content script.
  chrome.runtime.onMessage.addListener((msg: { type: string; status?: string }) => {
    if (msg.type === "CAPTURE_STATUS_UPDATE") {
      if (!currentShadow) return;
      const dot = currentShadow.querySelector(".cf-dot");
      if (!dot) return;
      dot.className = `cf-dot cf-dot--${
        msg.status === "capturing" ? "active" : "idle"
      }`;
    }
    if (msg.type === "SIDEBAR_CLOSED") {
      // Also clear busy — prevents the button being permanently locked if
      // the panel was force-closed while a click was in-flight.
      busy   = false;
      isOpen = false;
      updateBtn();
    }
  });

  // ── visibilitychange registered ONCE — not per inject ─────────────────────
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncState();
  }, { passive: true });

  // ── inject() only rebuilds DOM; all state/listeners live above ────────────
  function ensureInjected(): void {
    const existing = document.getElementById("cm-toggle-host");
    if (existing?.isConnected) return;
    inject();
  }

  function inject(): void {
    // Remove stale host if present
    document.getElementById("cm-toggle-host")?.remove();

    const host = document.createElement("div");
    host.id = "cm-toggle-host";
    // Use setProperty with "important" so platform CSS (even !important rules)
    // cannot hide or reposition the toggle host.
    const s = host.style;
    s.setProperty("position",       "fixed",      "important");
    s.setProperty("display",        "block",      "important");
    s.setProperty("top",            "72px",       "important");
    s.setProperty("right",          "0",          "important");
    s.setProperty("width",          "48px",       "important");
    s.setProperty("height",         "48px",       "important");
    s.setProperty("overflow",       "visible",    "important");
    s.setProperty("z-index",        "2147483647", "important");
    s.setProperty("pointer-events", "none",       "important");

    (document.documentElement ?? document.body).appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });
    // Update the module-level ref so the shared listeners and updateBtn()
    // always target the newly created shadow DOM on re-inject.
    currentShadow = shadow;

    const styleEl = document.createElement("style");
    styleEl.textContent = css;
    shadow.appendChild(styleEl);

    const btn = document.createElement("button");
    btn.className = "cf-toggle";
    btn.setAttribute("aria-label", "Toggle ContextMover sidebar");
    btn.innerHTML = `
    <img
      src="${logoUrl}"
      alt="ContextMover"
      style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block;pointer-events:none;"
      aria-hidden="true"
    />
    <span class="cf-dot cf-dot--idle" aria-hidden="true"></span>
  `;
    shadow.appendChild(btn);

    // Restore visual state immediately with current isOpen/busy, then confirm
    // the real state from the SW (catches tab-switch or extension reload desync).
    updateBtn();
    syncState();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();

      // Prevent double-click
      if (busy) return;
      busy = true;
      updateBtn();

      // Optimistic update — feels instant
      isOpen = !isOpen;
      updateBtn();

      // Safety — always clear busy after 2s in case SW callback never fires
      const safetyTimer = setTimeout(() => {
        busy = false;
        updateBtn();
      }, 2000);

      chrome.runtime.sendMessage(
        { type: "TOGGLE_SIDEBAR", shouldOpen: isOpen },
        (res) => {
          clearTimeout(safetyTimer);

          if (chrome.runtime.lastError) {
            // SW was sleeping — keep busy=true so the button stays locked during retry.
            // A second click here would race the retry with an opposite shouldOpen value.
            console.warn("[CM:toggle] SW sleeping, retrying...");
            setTimeout(() => {
              chrome.runtime.sendMessage(
                { type: "TOGGLE_SIDEBAR", shouldOpen: isOpen },
                (retryRes) => {
                  busy = false;
                  if (chrome.runtime.lastError) {
                    // Both failed — revert optimistic update
                    isOpen = !isOpen;
                    updateBtn();
                    return;
                  }
                  isOpen = retryRes?.isOpen ?? isOpen;
                  updateBtn();
                }
              );
            }, 150); // Short retry — SW wakes fast
            return;
          }

          // Success — confirm actual state from SW and release the lock
          busy   = false;
          isOpen = res?.isOpen ?? isOpen;
          updateBtn();
        }
      );
    });
  }

  ensureInjected();

  // Re-attach after SPA navigation
  window.addEventListener("popstate", ensureInjected);

  const _push = history.pushState.bind(history);
  history.pushState = (
    ...args: Parameters<typeof history.pushState>
  ) => {
    _push(...args);
    // Small delay — let SPA render first
    setTimeout(ensureInjected, 100);
  };
}
