import type { GenerateRequest, GenerateResponse } from '../shared/types';
import { runAgent } from './agent';

export async function generateFeature(req: GenerateRequest): Promise<GenerateResponse> {
  const result = await runAgent(req);
  // Attach trace to the response via a side channel — Phase 3
  // integration may surface it. For now, log to service worker:
  console.log('[bob] agent trace:', result.trace);
  const { trace, ...response } = result;
  return response;
}
