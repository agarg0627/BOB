// Owned by Person C.
import type { Feature } from '../shared/types';
import { Storage } from '../shared/storage';

export function runFeature(feature: Feature): { ok: boolean; error?: string } {
  const wrappedCode = `(function(){ try { ${feature.code} } catch(e){ throw e; } })()`;
  try {
    new Function(wrappedCode)();
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error };
  }
}

export async function runAllForUrl(
  url: string,
): Promise<{ ran: number; errors: string[] }> {
  const features = await Storage.matching(url);
  let ran = 0;
  const errors: string[] = [];
  for (const f of features) {
    const result = runFeature(f);
    if (result.ok) {
      ran++;
    } else {
      errors.push(`${f.name}: ${result.error ?? 'unknown error'}`);
    }
  }
  return { ran, errors };
}
