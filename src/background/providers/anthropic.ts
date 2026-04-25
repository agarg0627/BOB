import type { GenerateRequest, GenerateResponse } from '../../shared/types';
import type { Provider } from './types';
import { SYSTEM_PROMPT, buildUserPrompt, parseAndValidate } from './prompt';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const NAME = 'Anthropic';

export const anthropicProvider: Provider = {
  name: NAME,
  defaultModel: 'claude-sonnet-4-5',

  async generate(req: GenerateRequest, apiKey: string, model?: string): Promise<GenerateResponse> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: model || anthropicProvider.defaultModel,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(req) }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${NAME} API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const block = data.content?.find((c) => c.type === 'text');
    if (!block || typeof block.text !== 'string') {
      throw new Error(`${NAME}: no text block in response`);
    }
    return parseAndValidate(NAME, block.text, req);
  },
};
