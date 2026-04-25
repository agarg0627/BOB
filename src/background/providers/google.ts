import type { GenerateRequest, GenerateResponse } from '../../shared/types';
import type { Provider } from './types';
import { SYSTEM_PROMPT, buildUserPrompt, parseAndValidate } from './prompt';

const NAME = 'Google';

function endpoint(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

export const googleProvider: Provider = {
  name: NAME,
  defaultModel: 'gemini-2.0-flash',

  async generate(req: GenerateRequest, apiKey: string, model?: string): Promise<GenerateResponse> {
    const chosenModel = model || googleProvider.defaultModel;

    const res = await fetch(endpoint(chosenModel, apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(req) }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${NAME} API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`${NAME}: no text part in response`);
    }
    return parseAndValidate(NAME, text);
  },
};
