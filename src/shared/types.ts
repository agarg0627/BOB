export type LLMProvider = 'anthropic' | 'openai' | 'google';

export type EffortMode = 'standard' | 'high';

export interface ExtensionSettings {
  provider: LLMProvider;
  apiKeys: Partial<Record<LLMProvider, string>>;
  model?: string;
  effortMode?: EffortMode;
}

// One turn of the user/assistant refinement conversation. Past assistant
// turns carry a short summary of what was built, not the full code, so
// the LLM can see intent without re-ingesting prior outputs verbatim.
export interface RefinementTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  id: string;
  name: 'query_dom' | 'test_code';
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export interface AgentTrace {
  iterations: number;
  toolCalls: { name: string; input: unknown; resultPreview: string }[];
  retries: number;
}

export interface UserBehaviorEvent {
  type: 'click_close' | 'click_dismiss' | 'hide_element' | 'time_on_site';
  url: string;
  hostname: string;
  selector?: string;
  text?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type SuggestionDismissalState = 'none' | 'later' | 'never';

export interface Suggestion {
  id: string;
  hostname: string;
  proposedPrompt: string;
  rationale: string;
  confidence: number;
  evidenceCount: number;
  createdAt: number;
  // Three-state dismissal. `dismissed` (legacy) is mirrored from this for
  // backward compat with rows written before the field was introduced.
  dismissalState?: SuggestionDismissalState;
  // When `dismissalState === 'later'`, the suggestion auto-revives once
  // Date.now() exceeds this timestamp.
  laterUntil?: number;
  dismissed?: boolean;
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
  parentFeatureId?: string;
  iterationNumber?: number;
  agentTrace?: AgentTrace;
}

export interface GenerateRequest {
  prompt: string;
  url: string;
  domSnapshot?: string;
  existingCode?: string;
  existingFeatureName?: string;
  previousError?: string;
  tabId?: number;
  // Conversational refinement: prior turns of (user prompt, assistant
  // summary). When present together with existingCode, the agent treats
  // the new prompt as a refinement, not a replacement.
  refinementHistory?: RefinementTurn[];
  // 'high' enables provider-side reasoning/thinking and raises the
  // agent's iteration cap. Defaults to 'standard'.
  effortMode?: EffortMode;
}

export interface GenerateResponse {
  code: string;
  name: string;
  description: string;
  urlPattern: string;
}

export type Message =
  | { type: 'GENERATE_FEATURE'; req: GenerateRequest }
  | { type: 'GENERATE_FEATURE_STREAM'; req: GenerateRequest }
  | { type: 'TOOL_QUERY_DOM'; selector: string; tabId: number }
  | { type: 'TOOL_TEST_CODE'; code: string; tabId: number }
  | { type: 'TRACK_BEHAVIOR'; event: UserBehaviorEvent }
  | { type: 'GET_SUGGESTIONS'; hostname?: string }
  | { type: 'DISMISS_SUGGESTION'; id: string }
  | { type: 'ACCEPT_SUGGESTION'; id: string }
  | { type: 'BULK_TOGGLE'; enabled: boolean }
  | { type: 'BULK_DELETE' }
  | { type: 'OPEN_OVERLAY_FOR_EDIT'; featureId: string }
  | { type: 'OPEN_OVERLAY_WITH_PROMPT'; prompt: string }
  | { type: 'INSTALL_FEATURE'; feature: Omit<Feature, 'id' | 'createdAt'> }
  | { type: 'GET_FEATURES_FOR_URL'; url: string }
  | { type: 'LIST_FEATURES' }
  | { type: 'DELETE_FEATURE'; id: string }
  | { type: 'TOGGLE_FEATURE'; id: string; enabled: boolean }
  | { type: 'RUN_FEATURE'; featureId: string; code: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: Partial<ExtensionSettings> }
  | { type: 'RECORD_FEATURE_RESULT'; id: string; ok: boolean; error?: string }
  | { type: 'INSTALL_SPA_PATCH' }
  | { type: 'INSTALL_OBSERVER_HELPER' }
  | { type: 'GET_SUGGESTIONS_VISIBLE'; hostname?: string }
  | { type: 'SET_SUGGESTION_STATE'; id: string; state: SuggestionDismissalState }
  | { type: 'EXPORT_FEATURES' }
  | { type: 'IMPORT_FEATURES'; json: string; mode?: 'replace' | 'merge' };
