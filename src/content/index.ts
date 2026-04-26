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

// ---- Streaming generation helper ----

interface ProgressEvent {
  type: 'iteration' | 'tool_call' | 'tool_result' | 'final';
  n?: number;
  total?: number;
  name?: string;
  input?: unknown;
  preview?: string;
}

function formatProgressEvent(e: ProgressEvent): string {
  switch (e.type) {
    case 'iteration':
      return `Thinking\u2026 (step ${e.n})`;
    case 'tool_call':
      if (e.name === 'query_dom') return 'Inspecting page elements\u2026';
      if (e.name === 'test_code') return 'Testing the approach\u2026';
      return `Calling ${e.name}\u2026`;
    case 'tool_result':
      return 'Got results';
    case 'final':
      return 'Writing code\u2026';
    default:
      return '';
  }
}

function generateViaStream(
  req: import('../shared/types').GenerateRequest,
  onProgress: (message: string) => void,
): Promise<GenerateResponse> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const port = chrome.runtime.connect({ name: 'bob-stream-' + Math.random().toString(36).slice(2) });

    port.onMessage.addListener((msg: { type: string; event?: ProgressEvent; result?: GenerateResponse; error?: string }) => {
      if (resolved) return;
      if (msg.type === 'progress' && msg.event) {
        const text = formatProgressEvent(msg.event);
        if (text) onProgress(text);
      } else if (msg.type === 'done' && msg.result) {
        resolved = true;
        resolve(msg.result);
      } else if (msg.type === 'error') {
        resolved = true;
        reject(new Error(msg.error || 'Generation failed'));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Stream disconnected'));
      }
    });

    // Get the active tab id to pass along
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        port.postMessage({ type: 'START_STREAM', req, tabId: tab?.id });
      } catch (e) {
        resolved = true;
        reject(e);
      }
    })();
  });
}

// 3. Wire the overlay
initOverlay({
  onGenerate: async (prompt, options) => {
    let domSnapshot: string | undefined;
    try {
      domSnapshot = prunePage();
    } catch (e) {
      console.warn('[bob] prunePage failed, continuing without:', e);
    }
    const req = {
      prompt,
      url: location.href,
      domSnapshot,
      existingCode: options?.existingCode,
      existingFeatureName: options?.existingFeatureName,
      effortMode: options?.effortMode,
      refinementHistory: options?.refinementHistory,
    };

    const onProgress = options?.onProgress;

    // Try streaming via port for live progress
    if (onProgress) {
      try {
        const result = await generateViaStream(req, onProgress);
        return result;
      } catch (e) {
        console.warn('[bob] streaming failed, falling back to non-streaming:', e);
        // Fall through to non-streaming
      }
    }

    const res = await send<GenerateResponse | { error: string }>({
      type: 'GENERATE_FEATURE',
      req,
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

    // Hand the popup-side caller the id of the (possibly reflexion-replaced)
    // feature actually living in storage now, so it can deep-link or
    // highlight without re-querying.
    return { id: installed.id };
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
