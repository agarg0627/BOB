// Owned by Person A.
chrome.runtime.onInstalled.addListener(() => {
  console.log('[ext] background started');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[ext] background started');
});

chrome.runtime.onMessage.addListener(
  (msg: { type: string }, _sender, _sendResponse) => {
    switch (msg.type) {
      default:
        break;
    }
    return false;
  }
);

export {};
