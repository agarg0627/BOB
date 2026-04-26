import { runAllForUrl } from './injector';
import { send } from '../shared/messages';
import { initSpaWatcher } from './spa';
import { installObserverHelper } from './observer-helper';
import { initLifecycle } from './lifecycle';
import { initBehaviorTracker } from './behavior-tracker';
import { prunePage } from './dom-prune';
import {
  initOverlay,
  openOverlayForEdit,
  openOverlayWithPrompt,
  setOverlayKeybinds,
} from './overlay/overlay';
import { initQuickToggle, setQuickToggleKeybinds } from './quick-toggle';
import { eventToHotkey, isModifierKey } from '../shared/hotkey';
import type {
  ExtensionSettings,
  Feature,
  GenerateResponse,
  KeybindSettings,
  Message,
} from '../shared/types';

console.log('[bob] content script loaded on', location.href);

// 1. Initialize reactive runtime + behavior capture
initSpaWatcher();
installObserverHelper();
initBehaviorTracker();
initQuickToggle();

// Cache of features whose URL pattern matches the current page.
// Includes BOTH enabled and disabled features — the per-feature hotkey
// listener has to be able to flip a disabled feature back on, which
// means it needs visibility into disabled rows too. Storage.matching()
// filters by enabled, so we use LIST_FEATURES + client-side pattern
// matching here instead.
let cachedFeatures: Feature[] = [];

// URL-pattern glob → URL matcher. Same logic the storage layer uses
// internally; inlined here so the content script doesn't reach into
// other layers' privates.
function patternMatchesUrl(pattern: string, url: string): boolean {
  try {
    let body = '';
    for (const c of pattern) {
      if (c === '*') body += '.*';
      else if (c === '?') body += '.';
      else body += c.replace(/[.+^$(){}|\[\]\\\/]/g, '\\$&');
    }
    return new RegExp('^' + body + '$').test(url);
  } catch {
    return false;
  }
}

// Configured keybinds, mirrored from background/settings. The overlay
// and quick-toggle modules each keep their own copy; this one is used
// by the per-feature hotkey listener below for the refine-last combo.
const DEFAULT_KEYBINDS: KeybindSettings = {
  overlay: 'Ctrl+K',
  refineLast: 'Ctrl+I',
  quickToggle: 'Ctrl+Shift+Y',
};
let cachedKeybinds: KeybindSettings = { ...DEFAULT_KEYBINDS };

async function refreshFeatureCache(): Promise<void> {
  try {
    const list = await send<Feature[]>({ type: 'LIST_FEATURES' });
    if (!Array.isArray(list)) return;
    const url = location.href;
    cachedFeatures = list.filter((f) =>
      patternMatchesUrl(f.urlPattern, url),
    );
  } catch {
    // Background not ready / context invalidated — leave cache as-is.
  }
}

async function refreshKeybindsCache(): Promise<void> {
  try {
    const settings = await send<ExtensionSettings>({ type: 'GET_SETTINGS' });
    const k = settings?.keybinds ?? {};
    cachedKeybinds = {
      overlay: k.overlay || DEFAULT_KEYBINDS.overlay,
      refineLast: k.refineLast || DEFAULT_KEYBINDS.refineLast,
      quickToggle: k.quickToggle || DEFAULT_KEYBINDS.quickToggle,
    };
    setOverlayKeybinds(cachedKeybinds);
    setQuickToggleKeybinds(cachedKeybinds);
  } catch {
    // Background not ready — defaults remain.
  }
}

void refreshFeatureCache();
void refreshKeybindsCache();

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('features' in changes) void refreshFeatureCache();
    // settings live under the 'settings' key — see background/settings.ts
    if ('settings' in changes) void refreshKeybindsCache();
  });
} catch {
  // chrome.storage may be unavailable in some contexts (sandbox); skip.
}

// 2. Run features on page-ready and on every SPA navigation
initLifecycle({
  onPageReady: async () => {
    try {
      const r = await runAllForUrl(location.href);
      console.log('[bob] page ready, ran', r.ran, 'features, errors:', r.errors);
    } catch (e) {
      console.error('[bob] runAllForUrl on page ready failed:', e);
    }
    void refreshFeatureCache();
  },
  onUrlChange: async () => {
    try {
      const r = await runAllForUrl(location.href);
      console.log('[bob] url change, ran', r.ran, 'features, errors:', r.errors);
    } catch (e) {
      console.error('[bob] runAllForUrl on url change failed:', e);
    }
    void refreshFeatureCache();
  },
});

// ---- Per-feature hotkey + Cmd+I refine-last listener ----
//
// Capture-phase, attached to window. Skipped when the event target is:
//   - inside any input/textarea/contenteditable (don't steal user typing)
//   - the BOB overlay or quick-toggle shadow host (those have their own
//     keydown handling and shouldn't double-trigger)
//
// Cmd+I  → open the most-recently-installed matching feature in refine
//          mode (the unified edit flow).
// Other  → if any cached feature has hotkey === pressed combo, toggle
//          all matches and reload the page.
function eventTargetIsInputLike(e: KeyboardEvent): boolean {
  const t = e.target as Element | null;
  if (!t || t.nodeType !== 1) return false;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'bob-overlay-host' || tag === 'bob-toggle-host') return true;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((t as HTMLElement).isContentEditable) return true;
  return false;
}

window.addEventListener(
  'keydown',
  (e) => {
    if (isModifierKey(e)) return;
    if (eventTargetIsInputLike(e)) return;
    const hk = eventToHotkey(e);
    if (!hk) return;

    // Configured "refine last" combo (default Ctrl+I) opens the
    // most-recently-installed matching feature in refine mode.
    if (hk === cachedKeybinds.refineLast) {
      if (cachedFeatures.length === 0) return;
      const sorted = [...cachedFeatures].sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      e.preventDefault();
      e.stopPropagation();
      openOverlayForEdit(sorted[0]);
      return;
    }

    // Per-feature hotkey: toggle every feature whose stored hotkey matches.
    // We do not pre-filter on `enabled` so the same combo can both
    // enable a disabled feature and disable an enabled one.
    const matches = cachedFeatures.filter((f) => f.hotkey === hk);
    if (matches.length === 0) return;

    e.preventDefault();
    e.stopPropagation();

    void (async () => {
      for (const f of matches) {
        try {
          await send({
            type: 'TOGGLE_FEATURE',
            id: f.id,
            enabled: !f.enabled,
          });
        } catch {
          // Best-effort.
        }
      }
      // Reload to apply the new state. Short delay so the storage write
      // settles before document teardown.
      setTimeout(() => location.reload(), 150);
    })();
  },
  true,
);

// ---- Streaming generation helper ----

interface ProgressEvent {
  type: 'iteration' | 'tool_call' | 'tool_result' | 'thinking' | 'final';
  n?: number;
  total?: number;
  name?: string;
  input?: unknown;
  preview?: string;
  text?: string;
}

function formatProgressEvent(e: ProgressEvent): string {
  switch (e.type) {
    case 'iteration':
      return `Working\u2026 (step ${e.n})`;
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
  onProgress: (event: { type: 'status' | 'thinking'; text: string }) => void,
): Promise<GenerateResponse> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const port = chrome.runtime.connect({ name: 'bob-stream-' + Math.random().toString(36).slice(2) });

    port.onMessage.addListener((msg: { type: string; event?: ProgressEvent; result?: GenerateResponse; error?: string }) => {
      if (resolved) return;
      if (msg.type === 'progress' && msg.event) {
        if (msg.event.type === 'thinking' && msg.event.text) {
          onProgress({ type: 'thinking', text: msg.event.text });
        } else {
          const text = formatProgressEvent(msg.event);
          if (text) onProgress({ type: 'status', text });
        }
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

    // Background gets tabId from port.sender.tab.id automatically
    port.postMessage({ type: 'START_STREAM', req });
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
        const result = await generateViaStream(req, (event) => {
          onProgress(event);
        });
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
  onLoadRecentPrompts: async () => {
    try {
      const all = await send<Feature[]>({ type: 'LIST_FEATURES' });
      if (!Array.isArray(all)) return [];
      const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const f of sorted) {
        const p = (f.userPrompt ?? '').trim();
        if (!p) continue;
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
        if (out.length >= 3) break;
      }
      return out;
    } catch {
      return [];
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
