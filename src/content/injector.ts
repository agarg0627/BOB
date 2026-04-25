// Owned by Person C. Stub — implement in Phase 1.
import type { Feature } from '../shared/types';

export function runFeature(_feature: Feature): { ok: boolean; error?: string } {
  return { ok: false, error: 'not implemented' };
}

export async function runAllForUrl(_url: string): Promise<{ ran: number; errors: string[] }> {
  return { ran: 0, errors: [] };
}
