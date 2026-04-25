// Owned by Person A.
console.log('[ext] content script loaded on ' + location.href);

// Overlay won't exist until Person B's branch merges — catch the import error.
(async () => {
  try {
    const { initOverlay } = await import('./overlay/overlay');
    initOverlay({
      onSubmit: async (prompt: string) => {
        console.log('[ext] prompt:', prompt);
      },
    });
  } catch (e) {
    console.warn('[ext] overlay not available yet:', (e as Error).message);
  }
})();

// Message listener — switch placeholder for future handlers.
chrome.runtime.onMessage.addListener(
  (msg: { type: string }, _sender, _sendResponse) => {
    switch (msg.type) {
      default:
        break;
    }
  }
);

export {};
