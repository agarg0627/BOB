// Owned by Person D (popup).
// Called from background's RECORD_FEATURE_RESULT handler.
import type { Feature } from '../shared/types';
import { Storage } from '../shared/storage';

export async function recordResult(
  id: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  const feature = await Storage.get(id);
  if (!feature) return;

  const patch: Partial<Feature> = {
    lastRanAt: Date.now(),
    runCount: (feature.runCount ?? 0) + 1,
  };

  if (ok) {
    patch.lastError = undefined;
  } else {
    patch.lastError = error || 'unknown error';
    patch.errorCount = (feature.errorCount ?? 0) + 1;
  }

  await Storage.update(id, patch);
}
