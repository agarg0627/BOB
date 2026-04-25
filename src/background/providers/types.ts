import type { GenerateRequest, GenerateResponse } from '../../shared/types';

export interface Provider {
  name: string;
  defaultModel: string;
  generate(req: GenerateRequest, apiKey: string, model?: string): Promise<GenerateResponse>;
}
