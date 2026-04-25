import type { Feature } from '../shared/types';
import { send } from '../shared/messages';

export async function runFeature(
  feature: Feature
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await send<{ ok: boolean; error?: string }>({
      type: 'RUN_FEATURE',
      featureId: feature.id,
      code: feature.code,
    });
    return res;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function runAllForUrl(
  url: string
): Promise<{ ran: number; errors: string[] }> {
  const features = await send<Feature[]>({
    type: 'GET_FEATURES_FOR_URL',
    url,
  });
  const errors: string[] = [];
  let ran = 0;
  for (const f of features) {
    const r = await runFeature(f);
    // Record result for popup status display
    try {
      await send({
        type: 'RECORD_FEATURE_RESULT',
        id: f.id,
        ok: r.ok,
        error: r.error,
      });
    } catch { /* recording failure shouldn't break feature run */ }
    if (r.ok) ran++;
    else errors.push(`${f.name}: ${r.error}`);
  }
  return { ran, errors };
}
