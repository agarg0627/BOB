// Owned by Person A.
import { Storage } from '../shared/storage';
import { generateFeature } from './llm';
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
            const result = await generateFeature(msg.req);
            sendResponse(result);
            break;
          }
          case 'INSTALL_FEATURE': {
            const feature = await Storage.add(msg.feature);
            sendResponse(feature);
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
        }
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  },
);

export {};
