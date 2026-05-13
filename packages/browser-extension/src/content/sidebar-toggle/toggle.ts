// packages/browser-extension/src/content/sidebar-toggle/toggle.ts
// Fixed right-edge tab that opens/closes the ContextMover side panel.
// Vanilla TS only — no React, no drag, no settings.
import css from "./toggle.css?inline";
import logoUrl from "../../assets/logo.png?url";

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
    <img
      src="${logoUrl}"
      alt="ContextMover"
      style="
        width: 36px;
        height: 36px;
        border-radius: 50%;
        object-fit: cover;
        display: block;
        pointer-events: none;
      "
      aria-hidden="true"
    />
    <span class="cf-dot cf-dot--idle" aria-hidden="true"></span>`;
  shadow.appendChild(btn);

  let isOpen = false;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();

    console.log("[CM:toggle] clicked — sending TOGGLE_SIDEBAR");

    chrome.runtime.sendMessage(
      { type: "TOGGLE_SIDEBAR" },
      (res: { isOpen?: boolean; error?: string } | undefined) => {
        if (chrome.runtime.lastError) {
          console.error("[CM:toggle] lastError:", chrome.runtime.lastError.message);
          // SW may have gone to sleep — retry once after 500ms
          setTimeout(() => {
            chrome.runtime.sendMessage(
              { type: "TOGGLE_SIDEBAR" },
              (retryRes) => {
                if (chrome.runtime.lastError) return;
                isOpen = retryRes?.isOpen ?? !isOpen;
                btn.classList.toggle("cf-toggle--open", isOpen);
                console.log("[CM:toggle] retry response:", retryRes);
              }
            );
          }, 500);
          return;
        }
        console.log("[CM:toggle] response:", res);
        isOpen = res?.isOpen ?? !isOpen;
        btn.classList.toggle("cf-toggle--open", isOpen);
      }
    );
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    // Tab hidden → reset toggle state
    // Do NOT send close message — let sidebar persist
    // Just reset the icon visual state
    isOpen = false;
    btn.classList.remove("cf-toggle--open");
  });

  // Also handle actual tab switching via focus:
  window.addEventListener("blur", () => {
    // When tab loses focus but document stays visible
    // (e.g. switching between browser windows)
    // Reset icon state only — sidebar may still be open
    isOpen = false;
    btn.classList.remove("cf-toggle--open");
  });

  // Update capture dot when the service worker broadcasts a capture event.
  chrome.runtime.onMessage.addListener((msg: { type: string; status?: string }) => {
    if (msg.type !== "CAPTURE_STATUS_UPDATE") return;
    const dot = shadow.querySelector(".cf-dot");
    if (dot) dot.className = `cf-dot cf-dot--${msg.status === "capturing" ? "active" : "idle"}`;
  });

  return host;
}
