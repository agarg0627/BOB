import type { GenerateRequest, GenerateResponse, LLMProvider } from '../shared/types';
import type { Provider } from './providers/types';
import { getSettings } from './settings';
import { anthropicProvider } from './providers/anthropic';
import { openaiProvider } from './providers/openai';
import { googleProvider } from './providers/google';

const PROVIDERS: Record<LLMProvider, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
};

export async function generateFeature(req: GenerateRequest): Promise<GenerateResponse> {
  const settings = await getSettings();
  const provider = PROVIDERS[settings.provider];
  const apiKey = settings.apiKeys[settings.provider];
  if (!apiKey) {
    throw new Error(
      `No API key set for ${provider.name}. Open the BOB options page (right-click extension icon → Options) to add one.`,
    );
  }
  return provider.generate(req, apiKey, settings.model);
}
