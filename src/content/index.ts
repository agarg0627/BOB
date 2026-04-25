import { prunePage } from './dom-prune';
import { runAllForUrl } from './injector';
import { initOverlay } from './overlay/overlay';
import { send } from '../shared/messages';
import type { Feature, GenerateResponse } from '../shared/types';

console.log('[bob] content script loaded on', location.href);

(async () => {
  try {
    const result = await runAllForUrl(location.href);
    console.log('[bob] ran', result.ran, 'features, errors:', result.errors);
  } catch (e) {
    console.error('[bob] runAllForUrl failed:', e);
  }
})();

initOverlay({
  onGenerate: async (prompt: string): Promise<GenerateResponse> => {
    let domSnapshot: string | undefined;
    try {
      domSnapshot = prunePage();
    } catch (e) {
      console.warn('[bob] prunePage failed, sending without snapshot:', e);
    }
    const res = await send<GenerateResponse | { error: string }>({
      type: 'GENERATE_FEATURE',
      req: { prompt, url: location.href, domSnapshot },
    });
    if ('error' in res) throw new Error(res.error);
    return res;
  },
  onInstall: async (feature) => {
    const installed = await send<Feature>({
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
      },
    });
    const result = await send<{ ok: boolean; error?: string }>({
      type: 'RUN_FEATURE',
      featureId: installed.id,
      code: installed.code,
    });
    try {
      await send({
        type: 'RECORD_FEATURE_RESULT',
        id: installed.id,
        ok: result.ok,
        error: result.error,
      });
    } catch { /* ignore */ }
    if (!result.ok) throw new Error(result.error || 'feature failed to run');
  },
});
