import type { ToolCall } from '../../shared/types';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
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
  }): Promise<ProviderTurnResponse>;
}
