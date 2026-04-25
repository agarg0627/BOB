import type { ToolCall } from '../../shared/types';
import type { Provider, ProviderMessage, ProviderTurnResponse, ToolDefinition } from './types';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const NAME = 'Anthropic';

interface AnthropicContentBlock {
  // 'thinking' blocks appear when extended thinking is enabled. We do
  // not surface the chain-of-thought to the user or to the next
  // message turn — they're only for the model's own reasoning.
  type: 'text' | 'tool_use' | 'thinking' | string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

function toAnthropicMessages(
  messages: ProviderMessage[],
): Array<{ role: string; content: string | object[] }> {
  const out: Array<{ role: string; content: string | object[] }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled via top-level system param

    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: object[] = [];
      if (msg.content) {
        parts.push({ type: 'text', text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
      }
      out.push({ role: 'assistant', content: parts.length > 0 ? parts : msg.content });
      continue;
    }

    if (msg.role === 'tool') {
      // Anthropic expects tool results as user messages with tool_result content blocks.
      // Merge consecutive tool messages into a single user message.
      const last = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content };
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as object[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
  }

  return out;
}

function toToolDefinitions(
  tools: ToolDefinition[],
): Array<{ name: string; description: string; input_schema: object }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export const anthropicProvider: Provider = {
  name: NAME,
  defaultModel: 'claude-sonnet-4-5',

  async chat(args): Promise<ProviderTurnResponse> {
    const { messages, system, tools, apiKey, model, effortMode } = args;

    const high = effortMode === 'high';
    const body: Record<string, unknown> = {
      model: model || anthropicProvider.defaultModel,
      // High effort raises the output ceiling because extended-thinking
      // turns can spend several thousand tokens on the reasoning block
      // before producing the visible answer.
      max_tokens: high ? 8192 : 4096,
      system,
      messages: toAnthropicMessages(messages),
    };
    if (high) {
      body.thinking = { type: 'enabled', budget_tokens: 8000 };
    }
    if (tools.length > 0) {
      body.tools = toToolDefinitions(tools);
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${NAME} API error ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    const blocks = data.content ?? [];

    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        text += block.text;
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name as ToolCall['name'],
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    if (toolCalls.length > 0) {
      return { text: text || undefined, toolCalls, finishReason: 'tool_use' };
    }

    const reason = data.stop_reason === 'max_tokens' ? 'length' : 'end';
    return { text, finishReason: reason };
  },
};
