import type { ToolCall } from '../../shared/types';
import type { Provider, ProviderMessage, ProviderTurnResponse, ToolDefinition } from './types';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const NAME = 'OpenAI';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
}

function toOpenAIMessages(
  messages: ProviderMessage[],
  system: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  out.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (msg.role === 'system') continue; // already added above

    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      out.push(entry);
      continue;
    }

    if (msg.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
      continue;
    }
  }

  return out;
}

function toToolDefinitions(
  tools: ToolDefinition[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export const openaiProvider: Provider = {
  name: NAME,
  defaultModel: 'gpt-5.5',

  async chat(args): Promise<ProviderTurnResponse> {
    const { messages, system, tools, apiKey, model, effortMode } = args;

    const chosenModel = model || openaiProvider.defaultModel;
    const body: Record<string, unknown> = {
      model: chosenModel,
      messages: toOpenAIMessages(messages, system),
    };
    // reasoning_effort is currently honoured by gpt-5.x reasoning models.
    // Older / non-reasoning models reject the param, so we silently drop
    // it when the chosen model isn't gpt-5*.
    if (effortMode === 'high' && /^gpt-5/i.test(chosenModel)) {
      body.reasoning_effort = 'high';
    }
    if (tools.length > 0) {
      body.tools = toToolDefinitions(tools);
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${NAME} API error ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as { choices?: OpenAIChoice[] };
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error(`${NAME}: no message in response`);
    }

    const { message } = choice;
    const text = message.content ?? '';

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = message.tool_calls.map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = { raw: tc.function.arguments };
        }
        return {
          id: tc.id,
          name: tc.function.name as ToolCall['name'],
          input,
        };
      });
      return { text: text || undefined, toolCalls, finishReason: 'tool_use' };
    }

    const reason = choice.finish_reason === 'length' ? 'length' : 'end';
    return { text, finishReason: reason };
  },
};
