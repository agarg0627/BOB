// Exposes window.__bobObserve(slug, callback) in the page's MAIN
// world. LLM-generated features call it to set up reactive behavior
// that survives DOM mutations from infinite scroll, lazy loads, etc.
//
// The helper is installed by the background service worker via
// chrome.scripting.executeScript (bypasses CSP). The slug is used to
// dedupe across re-runs of the same feature: a second call with the
// same slug disconnects the previous observer first, so toggling a
// feature off and back on doesn't stack observers.

import { send } from '../shared/messages';

const INSTALLED_FLAG = '__bobObserveInstalled';

export async function installObserverHelper(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;
  try {
    await send({ type: 'INSTALL_OBSERVER_HELPER' });
  } catch (e) {
    console.error('[bob] observer helper installation failed:', e);
  }
}
