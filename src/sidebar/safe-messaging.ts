export function safeSendMessage<T = unknown>(
  message: Record<string, unknown>,
  callback?: (response: T) => void
): void {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      callback?.(response as T);
    });
  } catch {
    // SW may be sleeping or context invalidated — swallow silently.
  }
}

export function safeSendMessageAsync<T = unknown>(
  message: Record<string, unknown>
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve((response as T) ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}
