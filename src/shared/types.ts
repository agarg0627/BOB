export type LLMProvider = 'anthropic' | 'openai' | 'google';

export interface ExtensionSettings {
  provider: LLMProvider;
  apiKeys: Partial<Record<LLMProvider, string>>;
  model?: string;
}

export interface Feature {
  id: string;
  name: string;
  userPrompt: string;
  urlPattern: string;
  code: string;
  description: string;
  enabled: boolean;
  createdAt: number;
  lastError?: string;
  lastRanAt?: number;
  runCount: number;
  errorCount: number;
}

export interface GenerateRequest {
  prompt: string;
  url: string;
  domSnapshot?: string;
  existingCode?: string;
}

export interface GenerateResponse {
  code: string;
  name: string;
  description: string;
  urlPattern: string;
}

export type Message =
  | { type: 'GENERATE_FEATURE'; req: GenerateRequest }
  | { type: 'INSTALL_FEATURE'; feature: Omit<Feature, 'id' | 'createdAt'> }
  | { type: 'GET_FEATURES_FOR_URL'; url: string }
  | { type: 'LIST_FEATURES' }
  | { type: 'DELETE_FEATURE'; id: string }
  | { type: 'TOGGLE_FEATURE'; id: string; enabled: boolean }
  | { type: 'RUN_FEATURE'; featureId: string; code: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: Partial<ExtensionSettings> }
  | { type: 'RECORD_FEATURE_RESULT'; id: string; ok: boolean; error?: string };
