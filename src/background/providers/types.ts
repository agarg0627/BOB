import type { EffortMode, ToolCall } from '../../shared/types';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  // Function name for tool-role messages. Anthropic and OpenAI correlate
  // tool results by id; Gemini correlates by function name.
  toolName?: string;
}

export interface ProviderTurnResponse {
  text?: string;
  toolCalls?: ToolCall[];
  finishReason: 'end' | 'tool_use' | 'length' | 'error';
}

export interface ToolDefinition {
  name: 'query_dom' | 'test_code';
  description: string;
  inputSchema: object;
}

export interface Provider {
  name: string;
  defaultModel: string;
  chat(args: {
    messages: ProviderMessage[];
    system: string;
    tools: ToolDefinition[];
    apiKey: string;
    model?: string;
    // 'high' enables provider-side extended-reasoning features
    // (Anthropic thinking, OpenAI reasoning_effort, Gemini thinkingConfig).
    // Providers that don't support the feature for a given model must
    // silently drop the param.
    effortMode?: EffortMode;
  }): Promise<ProviderTurnResponse>;
}
