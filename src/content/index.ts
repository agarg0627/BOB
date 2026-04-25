// Owned by Person A.
import { send } from '../shared/messages';
import { initOverlay } from './overlay/overlay';
import { runAllForUrl, runFeature } from './injector';
import type { Feature, GenerateResponse } from '../shared/types';

console.log('[bob] content script loaded on ' + location.href);

(async () => {
  // 1. Run installed features for this URL
  try {
    const result = await runAllForUrl(location.href);
    console.log('[bob] ran', result.ran, 'features, errors:', result.errors);
  } catch (e) {
    console.error('[bob] failed to run features for URL:', e);
  }

  // 2. Initialize the overlay
  initOverlay({
    onSubmit: async (prompt: string) => {
      // a. Generate the feature
      const response = await send<GenerateResponse & { error?: string }>({
        type: 'GENERATE_FEATURE',
        req: { prompt, url: location.href },
      });

      // b. Surface errors from background
      if (response.error) {
        throw new Error(response.error);
      }

      // c. Auto-install (Phase 1 — no diff preview)
      const feature = await send<Feature>({
        type: 'INSTALL_FEATURE',
        feature: {
          code: response.code,
          name: response.name,
          description: response.description,
          urlPattern: response.urlPattern,
          userPrompt: prompt,
          enabled: true,
          runCount: 0,
          errorCount: 0,
        },
      });

      // d. Run immediately so user sees the effect
      await runFeature(feature);

      // e. Log
      console.log('[bob] feature installed and ran:', feature.name);
    },
  });
})();

export {};
