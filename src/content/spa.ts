// Detects same-origin SPA navigation by patching the History API in
// the page's MAIN world. The patch is installed by the background
// service worker via chrome.scripting.executeScript (bypasses CSP).
// The MAIN-world patch dispatches a CustomEvent on `window` which we
// listen for from the isolated world to drive listeners.

import { send } from '../shared/messages';

export type UrlChangeListener = (newUrl: string, oldUrl: string) => void;

const URL_EVENT = '__bob_url_change';
const ACTIVE_FLAG = '__bobSpaWatcherActive';
const DEBOUNCE_MS = 50;

const listeners = new Set<UrlChangeListener>();
let lastUrl = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  debounceTimer = null;
  const current = location.href;
  if (current === lastUrl) return;
  const old = lastUrl;
  lastUrl = current;
  // Snapshot so listeners can unsubscribe themselves without affecting
  // this dispatch loop.
  const snapshot = Array.from(listeners);
  for (const fn of snapshot) {
    try {
      fn(current, old);
    } catch (e) {
      console.error('[bob] url-change listener threw:', e);
    }
  }
}

function onMainWorldEvent(): void {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

export function onUrlChange(listener: UrlChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function initSpaWatcher(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  if (w[ACTIVE_FLAG]) return;
  w[ACTIVE_FLAG] = true;

  lastUrl = location.href;

  // Register the event listener before the patch is installed so we
  // don't miss any events.
  window.addEventListener(URL_EVENT, onMainWorldEvent);

  try {
    await send({ type: 'INSTALL_SPA_PATCH' });
  } catch (e) {
    console.error('[bob] SPA patch installation failed:', e);
  }
}
