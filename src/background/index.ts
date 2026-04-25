import { Storage } from '../shared/storage';
import { generateFeature } from './llm';
import { getSettings, setSettings } from './settings';
import { recordResult } from './error-recorder';
import {
  recordEvent,
  getSuggestions,
  dismissSuggestion,
  acceptSuggestion,
} from './suggestions-engine';
import type { Message } from '../shared/types';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ext] background started');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[ext] background started');
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
                func: (code: string) => {
                  try {
                    // Clear any previous run's error
                    (window as any).__bobLastError = undefined;
                    // @ts-ignore — trustedTypes isn't in default lib types
                    const tt = (window as any).trustedTypes;
                    let scriptValue: any = code;
                    if (tt && tt.createPolicy) {
                      // Policy names must be unique per page; reuse if it exists
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
                    // Check if the injected IIFE caught an error
                    const lastError = (window as any).__bobLastError;
                    if (lastError) {
                      (window as any).__bobLastError = undefined;
                      return { ok: false, error: lastError };
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
            const all = await Storage.list();
            for (const f of all) await Storage.update(f.id, { enabled: msg.enabled });
            sendResponse({ ok: true, count: all.length });
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
                  (window as any).__bobObserve = function (
                    slug: string,
                    callback: () => void,
                  ) {
                    if (typeof slug !== 'string' || typeof callback !== 'function') return;
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
            const all = await Storage.list();
            for (const f of all) await Storage.remove(f.id);
            sendResponse({ ok: true, count: all.length });
            break;
          }
        }
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  },
);

export {};
