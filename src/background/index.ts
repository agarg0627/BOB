import { Storage } from '../shared/storage';
import { generateFeature, generateFeatureWithProgress } from './llm';
import { getSettings, setSettings } from './settings';
import { recordResult } from './error-recorder';
import {
  recordEvent,
  getSuggestions,
  getVisibleSuggestions,
  setSuggestionState,
  dismissSuggestion,
  acceptSuggestion,
  debugForceSuggestions,
  debugSuggestionsState,
} from './suggestions-engine';
import type { GenerateRequest, Message } from '../shared/types';

// Initialize storage keys with empty defaults so:
//   1. Inspecting `chrome.storage.local` on a fresh install shows the
//      expected shape (no `undefined` for `suggestions` etc.)
//   2. Schema migrations can rely on a known starting point later.
// Idempotent: only sets keys that aren't already present.
async function initializeStorageDefaults(): Promise<void> {
  try {
    const existing = await chrome.storage.local.get([
      'behavior',
      'suggestions',
      'suggestionsMeta',
      'recentVisits',
      'siteSequences',
      'searchArrivals',
      'revisits',
    ]);
    const patch: Record<string, unknown> = {};
    if (!Array.isArray(existing.behavior)) patch.behavior = [];
    if (!Array.isArray(existing.suggestions)) patch.suggestions = [];
    if (!existing.suggestionsMeta || typeof existing.suggestionsMeta !== 'object') {
      patch.suggestionsMeta = { lastAnalyzedAt: {}, lastLlmAnalyzedAt: {} };
    }
    if (!Array.isArray(existing.recentVisits)) patch.recentVisits = [];
    if (!existing.siteSequences || typeof existing.siteSequences !== 'object') {
      patch.siteSequences = {};
    }
    if (!existing.searchArrivals || typeof existing.searchArrivals !== 'object') {
      patch.searchArrivals = {};
    }
    if (!existing.revisits || typeof existing.revisits !== 'object') {
      patch.revisits = {};
    }
    if (Object.keys(patch).length > 0) {
      await chrome.storage.local.set(patch);
      console.log('[bob] initialized storage defaults:', Object.keys(patch));
    }
  } catch (e) {
    console.warn('[bob] storage init failed:', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ext] background started (onInstalled)');
  void initializeStorageDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[ext] background started (onStartup)');
  void initializeStorageDefaults();
});

chrome.runtime.onMessage.addListener(
  (msg: Message, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'GENERATE_FEATURE': {
            const tabId = sender.tab?.id;
            const req = { ...msg.req, tabId };
            const result = await generateFeature(req);
            sendResponse(result);
            break;
          }
          case 'INSTALL_FEATURE': {
            const feature = await Storage.add(msg.feature);
            sendResponse(feature);
            break;
          }
          case 'GET_FEATURES_FOR_URL': {
            const arr = await Storage.matching(msg.url);
            sendResponse(arr);
            break;
          }
          case 'LIST_FEATURES': {
            const arr = await Storage.list();
            sendResponse(arr);
            break;
          }
          case 'DELETE_FEATURE': {
            await Storage.remove(msg.id);
            sendResponse({ ok: true });
            break;
          }
          case 'TOGGLE_FEATURE': {
            await Storage.update(msg.id, { enabled: msg.enabled });
            sendResponse({ ok: true });
            break;
          }
          case 'UPDATE_FEATURE': {
            await Storage.update(msg.id, msg.patch);
            sendResponse({ ok: true });
            break;
          }
          case 'RUN_FEATURE': {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
              sendResponse({ ok: false, error: 'no tab id' });
              break;
            }
            try {
              const results = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                // NOTE: this is intentionally synchronous. Async errors (from
                // setTimeout, MutationObserver callbacks, async/await in the
                // injected code) will not be captured in __bobLastError. The
                // IIFE wrapper's try/catch handles synchronous errors, which
                // is the common case. We previously tried a 250ms wait here
                // but reverted because the latency cost wasn't justified by
                // the small slice of async errors it caught.
                func: (code: string) => {
                  try {
                    (window as any).__bobLastError = undefined;
                    // @ts-ignore — trustedTypes isn't in default lib types
                    const tt = (window as any).trustedTypes;
                    let scriptValue: any = code;
                    if (tt && tt.createPolicy) {
                      const policy =
                        tt.defaultPolicy ??
                        tt.createPolicy('bob-injector-' + Math.random().toString(36).slice(2), {
                          createScript: (s: string) => s,
                          createHTML: (s: string) => s,
                          createScriptURL: (s: string) => s,
                        });
                      scriptValue = policy.createScript(code);
                    }
                    const script = document.createElement('script');
                    script.textContent = scriptValue;
                    (document.head || document.documentElement).appendChild(script);
                    script.remove();
                    const err = (window as any).__bobLastError;
                    if (err) {
                      (window as any).__bobLastError = undefined;
                      return { ok: false, error: err };
                    }
                    return { ok: true };
                  } catch (e) {
                    return { ok: false, error: String(e) };
                  }
                },
                args: [msg.code],
              });
              sendResponse(results[0].result);
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
            break;
          }
          case 'GET_SETTINGS': {
            const settings = await getSettings();
            sendResponse(settings);
            break;
          }
          case 'SET_SETTINGS': {
            const updated = await setSettings(msg.settings);
            sendResponse(updated);
            break;
          }
          case 'RECORD_FEATURE_RESULT': {
            await recordResult(msg.id, msg.ok, msg.error);
            sendResponse({ ok: true });
            break;
          }
          case 'TRACK_BEHAVIOR': {
            await recordEvent(msg.event);
            sendResponse({ ok: true });
            break;
          }
          case 'GET_SUGGESTIONS': {
            const list = await getSuggestions(msg.hostname);
            sendResponse(list);
            break;
          }
          case 'DISMISS_SUGGESTION': {
            await dismissSuggestion(msg.id);
            sendResponse({ ok: true });
            break;
          }
          case 'ACCEPT_SUGGESTION': {
            const result = await acceptSuggestion(msg.id);
            sendResponse(result);
            break;
          }
          case 'BULK_TOGGLE': {
            const count = await Storage.bulkPatch({ enabled: msg.enabled });
            sendResponse({ ok: true, count });
            break;
          }
          case 'INSTALL_SPA_PATCH': {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
              sendResponse({ ok: false, error: 'no tab id' });
              break;
            }
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                  if ((window as any).__bobSpaPatched) return;
                  (window as any).__bobSpaPatched = true;
                  const fire = () =>
                    window.dispatchEvent(new CustomEvent('__bob_url_change'));
                  const _ps = history.pushState;
                  history.pushState = function () {
                    const r = _ps.apply(this, arguments as any);
                    fire();
                    return r;
                  };
                  const _rs = history.replaceState;
                  history.replaceState = function () {
                    const r = _rs.apply(this, arguments as any);
                    fire();
                    return r;
                  };
                  window.addEventListener('popstate', fire);
                  window.addEventListener('hashchange', fire);
                },
              });
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
            break;
          }
          case 'INSTALL_OBSERVER_HELPER': {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
              sendResponse({ ok: false, error: 'no tab id' });
              break;
            }
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                  if ((window as any).__bobObserve) return;
                  const observers = new Map<string, MutationObserver>();
                  function bobDjb2(s: string): string {
                    let h = 5381;
                    for (let i = 0; i < s.length; i++) {
                      h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
                    }
                    return (h >>> 0).toString(36);
                  }
                  (window as any).__bobObserve = function (
                    callback: () => void,
                    opts?: { slug?: string },
                  ) {
                    if (typeof callback !== 'function') return;
                    const slug =
                      opts && typeof opts.slug === 'string' && opts.slug
                        ? opts.slug
                        : bobDjb2(String(callback));
                    const prev = observers.get(slug);
                    if (prev) prev.disconnect();

                    try {
                      callback();
                    } catch (e) {
                      console.error('[bob] observer init for ' + slug + ' threw:', e);
                    }

                    let timer: number | undefined;
                    const observer = new MutationObserver(() => {
                      if (timer !== undefined) clearTimeout(timer);
                      timer = window.setTimeout(() => {
                        try {
                          callback();
                        } catch (e) {
                          console.error('[bob] observer cb for ' + slug + ' threw:', e);
                        }
                      }, 100);
                    });
                    observer.observe(document.body || document.documentElement, {
                      childList: true,
                      subtree: true,
                    });
                    observers.set(slug, observer);
                  };
                },
              });
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
            break;
          }
          case 'BULK_DELETE': {
            const count = await Storage.removeAll();
            sendResponse({ ok: true, count });
            break;
          }
          case 'GET_SUGGESTIONS_VISIBLE': {
            const list = await getVisibleSuggestions(msg.hostname);
            sendResponse(list);
            break;
          }
          case 'SET_SUGGESTION_STATE': {
            await setSuggestionState(msg.id, msg.state);
            sendResponse({ ok: true });
            break;
          }
          case 'EXPORT_FEATURES': {
            const all = await Storage.list();
            const json = JSON.stringify({
              version: 1,
              exportedAt: Date.now(),
              features: all,
            }, null, 2);
            sendResponse({ json });
            break;
          }
          case 'IMPORT_FEATURES': {
            const parsed = JSON.parse(msg.json);
            if (!parsed.features || !Array.isArray(parsed.features)) {
              sendResponse({ error: 'Invalid format' });
              break;
            }
            if (msg.mode === 'replace') {
              const existing = await Storage.list();
              for (const f of existing) await Storage.remove(f.id);
            }
            let count = 0;
            for (const f of parsed.features) {
              const { id, createdAt, ...rest } = f;
              await Storage.add(rest);
              count++;
            }
            sendResponse({ count });
            break;
          }
          case 'DEBUG_FORCE_SUGGESTIONS': {
            // Bypass throttles and run heuristic + LLM analysis right
            // now for the requested hostname. Returns a small report
            // so the SW console can verify it actually ran.
            const report = await debugForceSuggestions(msg.hostname);
            sendResponse(report);
            break;
          }
          case 'DEBUG_SUGGESTIONS_STATE': {
            const report = await debugSuggestionsState(msg.hostname);
            sendResponse(report);
            break;
          }
          default: {
            // Unknown message — respond so the channel doesn't dangle.
            sendResponse({ error: `unknown message type: ${(msg as { type?: string }).type}` });
          }
        }
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  },
);

// Streaming generation via long-lived port
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('bob-stream-')) return;

  const tabId = port.sender?.tab?.id;

  port.onMessage.addListener((msg: { type: string; req?: GenerateRequest }) => {
    if (msg.type !== 'START_STREAM' || !msg.req) return;

    if (tabId === undefined) {
      try { port.postMessage({ type: 'error', error: 'no tab id from port sender' }); } catch { /* port closed */ }
      try { port.disconnect(); } catch { /* already disconnected */ }
      return;
    }

    const req = { ...msg.req, tabId };

    (async () => {
      try {
        const result = await generateFeatureWithProgress(req, (event) => {
          try { port.postMessage({ type: 'progress', event }); } catch { /* port closed */ }
        });
        try { port.postMessage({ type: 'done', result }); } catch { /* port closed */ }
      } catch (e) {
        try { port.postMessage({ type: 'error', error: String(e) }); } catch { /* port closed */ }
      }
    })();
  });
});

export {};
