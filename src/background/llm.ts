import type { GenerateRequest, GenerateResponse } from '../shared/types';
import { runAgent } from './agent';
import type { ProgressCallback } from './agent';

export async function generateFeature(req: GenerateRequest): Promise<GenerateResponse> {
  const result = await runAgent(req);
  console.log('[bob] agent trace:', result.trace);
  const { trace, ...response } = result;
  return response;
}

export async function generateFeatureWithProgress(
  req: GenerateRequest,
  onProgress: ProgressCallback,
): Promise<GenerateResponse> {
  const result = await runAgent(req, onProgress);
  console.log('[bob] agent trace:', result.trace);
  const { trace, ...response } = result;
  return response;
}
