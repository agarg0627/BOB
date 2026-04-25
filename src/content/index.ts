import { runAllForUrl } from './injector';
import { send } from '../shared/messages';
import { initSpaWatcher } from './spa';
import { installObserverHelper } from './observer-helper';
import { initLifecycle } from './lifecycle';
import { initBehaviorTracker } from './behavior-tracker';
import { prunePage } from './dom-prune';
import { initOverlay, openOverlayForEdit, openOverlayWithPrompt } from './overlay/overlay';
import type { Feature, GenerateResponse, Message } from '../shared/types';

console.log('[bob] content script loaded on', location.href);

// 1. Initialize reactive runtime + behavior capture
initSpaWatcher();
installObserverHelper();
initBehaviorTracker();

// 2. Run features on page-ready and on every SPA navigation
initLifecycle({
  onPageReady: async () => {
    try {
      const r = await runAllForUrl(location.href);
      console.log('[bob] page ready, ran', r.ran, 'features, errors:', r.errors);
    } catch (e) {
      console.error('[bob] runAllForUrl on page ready failed:', e);
    }
  },
  onUrlChange: async () => {
    try {
      const r = await runAllForUrl(location.href);
      console.log('[bob] url change, ran', r.ran, 'features, errors:', r.errors);
    } catch (e) {
      console.error('[bob] runAllForUrl on url change failed:', e);
    }
  },
});

// 3. Wire the overlay
initOverlay({
  onGenerate: async (prompt, options) => {
    let domSnapshot: string | undefined;
    try {
      domSnapshot = prunePage();
    } catch (e) {
      console.warn('[bob] prunePage failed, continuing without:', e);
    }
    const res = await send<GenerateResponse | { error: string }>({
      type: 'GENERATE_FEATURE',
      req: {
        prompt,
        url: location.href,
        domSnapshot,
        existingCode: options?.existingCode,
        existingFeatureName: options?.existingFeatureName,
      },
    });
    if ('error' in res) throw new Error(res.error);
    return res;
  },
  onInstall: async (feature) => {
    // Iteration: if editing, delete the parent first to avoid duplicates
    if (feature.parentFeatureId) {
      try {
        await send({ type: 'DELETE_FEATURE', id: feature.parentFeatureId });
      } catch (e) {
        console.warn('[bob] failed to delete parent during edit:', e);
      }
    }
    let installed = await send<Feature>({
      type: 'INSTALL_FEATURE',
      feature: {
        code: feature.code,
        name: feature.name,
        description: feature.description,
        urlPattern: feature.urlPattern,
        userPrompt: feature.userPrompt,
        enabled: true,
        runCount: 0,
        errorCount: 0,
        parentFeatureId: feature.parentFeatureId,
        iterationNumber: feature.parentFeatureId
          ? (feature.iterationNumber ?? 0) + 1
          : 0,
      },
    });
    let result = await send<{ ok: boolean; error?: string }>({
      type: 'RUN_FEATURE',
      featureId: installed.id,
      code: installed.code,
    });

    // Reflexion: retry up to 2 times with previousError feedback
    for (let retry = 0; retry < 2 && !result.ok; retry++) {
      console.log('[bob] reflexion retry', retry + 1, 'error was:', result.error);
      // Re-prune the DOM so the model has current page context for the fix.
      let retryDom: string | undefined;
      try {
        retryDom = prunePage();
      } catch {
        retryDom = undefined;
      }
      let fixed: GenerateResponse | { error: string };
      try {
        fixed = await send<GenerateResponse | { error: string }>({
          type: 'GENERATE_FEATURE',
          req: {
            prompt: feature.userPrompt,
            url: location.href,
            domSnapshot: retryDom,
            existingCode: installed.code,
            existingFeatureName: feature.name,
            previousError: result.error,
          },
        });
      } catch (e) {
        console.warn('[bob] reflexion generate failed:', e);
        break;
      }
      if (typeof (fixed as GenerateResponse).code !== 'string') break;
      const okFixed = fixed as GenerateResponse;
      // Replace the broken feature with the fixed one. Preserve parent /
      // iteration linkage from the user-supplied feature so the iteration
      // tree stays intact across retries.
      try {
        await send({ type: 'DELETE_FEATURE', id: installed.id });
        installed = await send<Feature>({
          type: 'INSTALL_FEATURE',
          feature: {
            ...okFixed,
            userPrompt: feature.userPrompt,
            enabled: true,
            runCount: 0,
            errorCount: 0,
            ...(feature.parentFeatureId
              ? {
                  parentFeatureId: feature.parentFeatureId,
                  iterationNumber: feature.iterationNumber,
                }
              : {}),
          },
        });
        result = await send<{ ok: boolean; error?: string }>({
          type: 'RUN_FEATURE',
          featureId: installed.id,
          code: installed.code,
        });
      } catch (e) {
        console.warn('[bob] reflexion install/run failed:', e);
        break;
      }
    }

    // Record the final result
    try {
      await send({
        type: 'RECORD_FEATURE_RESULT',
        id: installed.id,
        ok: result.ok,
        error: result.error,
      });
    } catch { /* recording is non-critical */ }

    if (!result.ok) {
      throw new Error(result.error || 'feature failed to run');
    }
  },
});

// 4. Listen for popup → content-script messages
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === 'OPEN_OVERLAY_FOR_EDIT') {
    (async () => {
      try {
        const features = await send<Feature[]>({ type: 'LIST_FEATURES' });
        const f = features.find((x) => x.id === msg.featureId);
        if (f) {
          openOverlayForEdit(f);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'feature not found' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === 'OPEN_OVERLAY_WITH_PROMPT') {
    try {
      openOverlayWithPrompt(msg.prompt);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
  return false;
});
