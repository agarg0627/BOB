// Owned by Person A. Stub — implement in Phase 1.
console.log('[bob] background started');

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  console.log('[bob] background received message', msg);
  return false;
});

export {};
