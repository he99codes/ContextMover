import css from "./toggle.css?inline";
import logoUrl from "../../assets/logo.png?url";

const GUARD = "__cm_toggle_v2";
const w = window as unknown as Record<string, unknown>;
if (!w[GUARD]) { w[GUARD] = true; init(); }

function init(): void {
  let host: HTMLElement | null = null;

  function ensureInjected(): void {
    if (host?.isConnected) return;
    host = inject();
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

function inject(): HTMLElement {
  // Remove any existing toggle first
  document.getElementById("cm-toggle-host")?.remove();

  const host = document.createElement("div");
  host.id = "cm-toggle-host";
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

  const shadow = host.attachShadow({ mode: "open" });

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

  // Local state
  let isOpen = false;
  let busy = false;

  // Sync state on inject
  syncState();

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

  function updateBtn(): void {
    btn.classList.toggle("cf-toggle--open", isOpen);
    btn.classList.toggle("cf-toggle--busy", busy);
  }

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();

    // Prevent double-click
    if (busy) return;
    busy = true;
    updateBtn();

    // Optimistic update — feels instant
    isOpen = !isOpen;
    updateBtn();

    chrome.runtime.sendMessage(
      { type: "TOGGLE_SIDEBAR" },
      (res) => {
        busy = false;

        if (chrome.runtime.lastError) {
          // SW was sleeping — wake it up and retry
          console.warn("[CM:toggle] SW sleeping, retrying...");
          setTimeout(() => {
            chrome.runtime.sendMessage(
              { type: "TOGGLE_SIDEBAR" },
              (retryRes) => {
                if (chrome.runtime.lastError) {
                  // Both failed — revert
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

        // Confirm actual state from SW
        isOpen = res?.isOpen ?? isOpen;
        updateBtn();
      }
    );
  });

  // Sync when tab becomes visible again
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) syncState();
    },
    { passive: true }
  );

  // Listen for capture status
  chrome.runtime.onMessage.addListener(
    (msg: { type: string; status?: string }) => {
      if (msg.type !== "CAPTURE_STATUS_UPDATE") return;
      const dot = shadow.querySelector(".cf-dot");
      if (!dot) return;
      dot.className = `cf-dot cf-dot--${
        msg.status === "capturing" ? "active" : "idle"
      }`;
    }
  );

  // Listen for sidebar closed from outside
  // (user clicks X in sidebar, or navigates away)
  chrome.runtime.onMessage.addListener(
    (msg: { type: string }) => {
      if (msg.type === "SIDEBAR_CLOSED") {
        isOpen = false;
        updateBtn();
      }
    }
  );

  return host;
}
