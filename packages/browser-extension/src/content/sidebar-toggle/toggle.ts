// packages/browser-extension/src/content/sidebar-toggle/toggle.ts
// Fixed right-edge tab that opens/closes the ContextMover side panel.
// Vanilla TS only — no React, no drag, no settings.
import css from "./toggle.css?inline";

const GUARD = "__cf_toggle_v1";
const w = window as unknown as Record<string, unknown>;
if (!w[GUARD]) { w[GUARD] = true; init(); }

function init(): void {
  let host: HTMLElement | null = null;

  function ensureInjected(): void {
    if (host?.isConnected) return;
    host = inject();
  }

  ensureInjected();

  // Re-attach after SPA navigation (pushState / popstate).
  window.addEventListener("popstate", ensureInjected);
  const _push = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    _push(...args);
    ensureInjected();
  };
}

function inject(): HTMLElement {
  // Zero-size host fixed to viewport right edge, vertically centred.
  const host = document.createElement("div");
  host.id = "cf-toggle-host";
  Object.assign(host.style, {
    position:      "fixed",
    top:           "72px",
    right:         "0",
    width:         "0",
    height:        "0",
    overflow:      "visible",
    zIndex:        "2147483647",
    pointerEvents: "none",
  });
  (document.documentElement ?? document.body).appendChild(host);

  const shadow  = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  const btn = document.createElement("button");
  btn.className = "cf-toggle";
  btn.setAttribute("aria-label", "Toggle ContextMover sidebar");
  btn.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2L3 6.5V13.5L10 18L17 13.5V6.5L10 2Z" fill="currentColor"/>
      <path d="M10 5.5L5.5 8V12L10 14.5L14.5 12V8L10 5.5Z" style="fill:var(--cf-inner)"/>
      <circle cx="10" cy="10" r="2.2" fill="currentColor"/>
    </svg>
    <span class="cf-dot cf-dot--idle" aria-hidden="true"></span>`;
  shadow.appendChild(btn);

  let isOpen = false;

  btn.addEventListener("click", () => {
    console.log("[CM:toggle] button clicked");
    chrome.runtime.sendMessage({ type: "TOGGLE_SIDEBAR" }, (res: { isOpen?: boolean; error?: string }) => {
      if (chrome.runtime.lastError) {
        console.error("[CM:toggle] lastError:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[CM:toggle] response:", res);
      isOpen = res?.isOpen ?? !isOpen;
      btn.classList.toggle("cf-toggle--open", isOpen);
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isOpen) {
      chrome.runtime.sendMessage({ type: "CLOSE_SIDEBAR" });
      isOpen = false;
      btn.classList.remove("cf-toggle--open");
    }
  });

  // Update capture dot when the service worker broadcasts a capture event.
  chrome.runtime.onMessage.addListener((msg: { type: string; status?: string }) => {
    if (msg.type !== "CAPTURE_STATUS_UPDATE") return;
    const dot = shadow.querySelector(".cf-dot");
    if (dot) dot.className = `cf-dot cf-dot--${msg.status === "capturing" ? "active" : "idle"}`;
  });

  return host;
}
