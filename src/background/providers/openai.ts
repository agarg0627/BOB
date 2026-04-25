import type { GenerateRequest, GenerateResponse } from '../../shared/types';
import type { Provider } from './types';
import { SYSTEM_PROMPT, buildUserPrompt, parseAndValidate } from './prompt';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const NAME = 'OpenAI';

export const openaiProvider: Provider = {
  name: NAME,
  defaultModel: 'gpt-4o-mini',

  async generate(req: GenerateRequest, apiKey: string, model?: string): Promise<GenerateResponse> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model || openaiProvider.defaultModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(req) },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${NAME} API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`${NAME}: no message content in response`);
    }
    return parseAndValidate(NAME, content);
  },
};
