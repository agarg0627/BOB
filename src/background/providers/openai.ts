import type { ToolCall } from '../../shared/types';
import type { Provider, ProviderMessage, ProviderTurnResponse, ToolDefinition } from './types';

const COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const NAME = 'OpenAI';

// gpt-5.x and o-series reasoning models support (and require, when
// combined with tools + reasoning_effort) the Responses API. Older
// models (gpt-4o, gpt-4.1, gpt-3.5-turbo, etc.) stay on chat completions
// so manually pinned configurations keep working.
function usesResponsesApi(model: string): boolean {
  return /^gpt-5/i.test(model) || /^o[1-9]/i.test(model);
}

// ---- Chat Completions path (older / non-reasoning models) ----

interface CompletionsToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CompletionsChoice {
  message?: {
    content?: string | null;
    tool_calls?: CompletionsToolCall[];
  };
  finish_reason?: string;
}

function toCompletionsMessages(
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

function toCompletionsTools(
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

async function chatViaCompletions(args: {
  messages: ProviderMessage[];
  system: string;
  tools: ToolDefinition[];
  apiKey: string;
  model: string;
  effortMode?: 'standard' | 'high';
}): Promise<ProviderTurnResponse> {
  const { messages, system, tools, apiKey, model, effortMode } = args;

  const body: Record<string, unknown> = {
    model,
    messages: toCompletionsMessages(messages, system),
  };
  // reasoning_effort on chat completions still works for gpt-5* without
  // tools. With tools, OpenAI rejects the combination and asks for the
  // Responses API — that path is handled by chatViaResponses, which is
  // selected by usesResponsesApi(). Older non-reasoning models reject
  // the param, so we silently drop it for them.
  // Note: OpenAI reasoning models do not expose their reasoning/thinking
  // text in the API response, so thinkingText is never returned here.
  if (effortMode === 'high' && /^gpt-5/i.test(model)) {
    body.reasoning_effort = 'high';
  }
  if (tools.length > 0) {
    body.tools = toCompletionsTools(tools);
  }

  const res = await fetch(COMPLETIONS_ENDPOINT, {
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

  const data = (await res.json()) as { choices?: CompletionsChoice[] };
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
}

// ---- Responses API path (gpt-5.x and o-series reasoning models) ----

type ResponsesInputItem =
  | {
      type: 'message';
      role: 'user' | 'assistant';
      content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'output_text'; text: string }
      >;
    }
  | {
      type: 'function_call';
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    };

interface ResponsesMessageOutput {
  type: 'message';
  role: 'assistant';
  content?: Array<{ type: string; text?: string }>;
}

interface ResponsesFunctionCallOutput {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesReasoningOutput {
  type: 'reasoning';
  summary?: unknown[];
  encrypted_content?: string;
}

type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesFunctionCallOutput
  | ResponsesReasoningOutput
  | { type: string; [k: string]: unknown };

interface ResponsesBody {
  output?: ResponsesOutputItem[];
  status?: string;
  error?: { message?: string };
}

function toResponsesInput(messages: ProviderMessage[]): {
  items: ResponsesInputItem[];
  extraInstructions: string[];
} {
  const items: ResponsesInputItem[] = [];
  const extraInstructions: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System messages embedded in the messages array are concatenated
      // into the top-level `instructions` field. agent.ts passes the
      // system prompt via the dedicated arg, so this branch is rare —
      // kept for parity with toCompletionsMessages's defensive skip.
      if (msg.content) extraInstructions.push(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      items.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: msg.content }],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.content && msg.content.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }],
        });
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          items.push({
            type: 'function_call',
            // The Responses API requires `id` to start with 'fc_'.
            // Our ToolCall.id comes from the API's call_id (starts with
            // 'call_'), so we derive an fc_-prefixed id for the item.
            // call_id stays as the original — it's the correlation key
            // that matches the function_call_output we emit for the
            // tool result.
            id: 'fc_' + tc.id.replace(/^call_/, ''),
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          });
        }
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Responses API correlates tool results to calls via call_id (not
      // by role: 'tool' as in chat completions). The toolCallId threaded
      // through from the prior function_call item becomes the call_id.
      items.push({
        type: 'function_call_output',
        call_id: msg.toolCallId ?? '',
        output: msg.content,
      });
      continue;
    }
  }

  return { items, extraInstructions };
}

function toResponsesTools(
  tools: ToolDefinition[],
): Array<{ type: 'function'; name: string; description: string; parameters: object; strict: boolean }> {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    // We don't enforce JSON schema on tool inputs — the dispatcher
    // tolerates malformed args and the agent loop can recover.
    strict: false,
  }));
}

async function chatViaResponses(args: {
  messages: ProviderMessage[];
  system: string;
  tools: ToolDefinition[];
  apiKey: string;
  model: string;
  effortMode?: 'standard' | 'high';
}): Promise<ProviderTurnResponse> {
  const { messages, system, tools, apiKey, model, effortMode } = args;

  const { items, extraInstructions } = toResponsesInput(messages);
  const instructions = [system, ...extraInstructions].filter(Boolean).join('\n\n');

  const body: Record<string, unknown> = {
    model,
    input: items,
    instructions,
    // We manage message history client-side in agent.ts — no
    // previous_response_id chaining wanted.
    store: false,
  };
  if (tools.length > 0) {
    body.tools = toResponsesTools(tools);
  }
  if (effortMode === 'high') {
    body.reasoning = { effort: 'high' };
  }

  const res = await fetch(RESPONSES_ENDPOINT, {
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

  const data = (await res.json()) as ResponsesBody;

  if (data.status === 'failed') {
    const reason = data.error?.message || 'response failed';
    throw new Error(`${NAME}: ${reason}`);
  }

  const output = data.output ?? [];
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const item of output) {
    // Skip reasoning summary items. OpenAI only returns summaries (the
    // raw chain-of-thought is hidden), so they're not useful to surface
    // as thinkingText; we never error on them.
    if (item.type === 'reasoning') continue;

    if (item.type === 'message') {
      const msgItem = item as ResponsesMessageOutput;
      for (const part of msgItem.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      const fc = item as ResponsesFunctionCallOutput;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(fc.arguments);
      } catch {
        input = { raw: fc.arguments };
      }
      toolCalls.push({
        id: fc.call_id,
        name: fc.name as ToolCall['name'],
        input,
      });
      continue;
    }

    // Unknown item types are ignored — keeps us forward-compatible if
    // OpenAI adds new output kinds.
  }

  if (toolCalls.length > 0) {
    return { text: text || undefined, toolCalls, finishReason: 'tool_use' };
  }
  if (data.status === 'incomplete') {
    return { text, finishReason: 'length' };
  }
  return { text, finishReason: 'end' };
}

// ---- Provider entry point ----

export const openaiProvider: Provider = {
  name: NAME,
  defaultModel: 'gpt-5.5',

  async chat(args): Promise<ProviderTurnResponse> {
    const chosenModel = args.model || openaiProvider.defaultModel;
    if (usesResponsesApi(chosenModel)) {
      return chatViaResponses({ ...args, model: chosenModel });
    }
    return chatViaCompletions({ ...args, model: chosenModel });
  },
};
