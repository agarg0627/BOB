import type { ToolCall } from '../../shared/types';
import type { Provider, ProviderMessage, ProviderTurnResponse, ToolDefinition } from './types';

const NAME = 'Google';

function endpoint(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

function toGeminiContents(
  messages: ProviderMessage[],
): Array<{ role: string; parts: GeminiPart[] }> {
  const out: Array<{ role: string; parts: GeminiPart[] }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled via systemInstruction

    if (msg.role === 'user') {
      out.push({ role: 'user', parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.input } });
        }
      }
      if (parts.length === 0) parts.push({ text: '' });
      out.push({ role: 'model', parts });
      continue;
    }

    if (msg.role === 'tool') {
      // Gemini has no dedicated tool role. Tool results go as user-role
      // messages with functionResponse parts, correlated by function NAME
      // (not by id like Anthropic/OpenAI). Merge consecutive tool messages
      // into a single user turn.
      const part: GeminiPart = {
        functionResponse: {
          name: msg.toolName ?? 'unknown',
          response: { content: msg.content },
        },
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.parts.some((p) => p.functionResponse)) {
        last.parts.push(part);
      } else {
        out.push({ role: 'user', parts: [part] });
      }
      continue;
    }
  }

  return out;
}

function toToolDeclarations(
  tools: ToolDefinition[],
): Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: object }> }> {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

export const googleProvider: Provider = {
  name: NAME,
  defaultModel: 'gemini-3.1-pro-preview',

  async chat(args): Promise<ProviderTurnResponse> {
    const { messages, system, tools, apiKey, model, effortMode } = args;
    const chosenModel = model || googleProvider.defaultModel;

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: 4096,
    };
    // thinkingConfig is honoured by Gemini 2.5+/3.x reasoning-capable
    // models. We emit it only for high-effort runs; standard mode omits
    // the field so models that don't recognise it are unaffected.
    if (effortMode === 'high') {
      generationConfig.thinkingConfig = {
        includeThoughts: false,
        thinkingBudget: 8192,
      };
    }

    const body: Record<string, unknown> = {
      contents: toGeminiContents(messages),
      systemInstruction: { parts: [{ text: system }] },
      generationConfig,
    };

    const toolDecls = toToolDeclarations(tools);
    if (toolDecls.length > 0) {
      body.tools = toolDecls;
    }

    const res = await fetch(endpoint(chosenModel, apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${NAME} API error ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as { candidates?: GeminiCandidate[] };
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        text += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name as ToolCall['name'],
          input: part.functionCall.args ?? {},
        });
      }
    }

    if (toolCalls.length > 0) {
      return { text: text || undefined, toolCalls, finishReason: 'tool_use' };
    }

    const reason = candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'end';
    return { text, finishReason: reason };
  },
};
