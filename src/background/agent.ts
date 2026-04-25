import type { GenerateRequest, GenerateResponse, AgentTrace } from '../shared/types';
import { getSettings } from './settings';
import { dispatchTool, TOOL_DEFINITIONS } from './tools';
import { SYSTEM_PROMPT, buildUserPrompt } from './providers/prompt';
import { anthropicProvider } from './providers/anthropic';
import { openaiProvider } from './providers/openai';
import { googleProvider } from './providers/google';
import type { Provider, ProviderMessage } from './providers/types';

const PROVIDERS: Record<string, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
};

const MAX_ITERATIONS = 6;

export async function runAgent(
  req: GenerateRequest,
): Promise<GenerateResponse & { trace: AgentTrace }> {
  const settings = await getSettings();
  const provider = PROVIDERS[settings.provider];
  const apiKey = settings.apiKeys[settings.provider];
  if (!apiKey) {
    throw new Error(`No API key for ${provider.name}. Open BOB options.`);
  }

  const messages: ProviderMessage[] = [
    { role: 'user', content: buildUserPrompt(req) },
  ];
  const trace: AgentTrace = { iterations: 0, toolCalls: [], retries: 0 };

  // Tools only available if we have a tabId (so the agent can act
  // on the user's tab). Without one, fall back to non-tool generation.
  const tools = req.tabId !== undefined ? [...TOOL_DEFINITIONS] : [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    trace.iterations++;
    const turn = await provider.chat({
      messages,
      system: SYSTEM_PROMPT,
      tools,
      apiKey,
      model: settings.model,
    });

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      // Append assistant turn with tool calls
      messages.push({
        role: 'assistant',
        content: turn.text || '',
        toolCalls: turn.toolCalls,
      });
      // Dispatch each tool, append tool_result messages
      for (const call of turn.toolCalls) {
        const result = await dispatchTool(call, req.tabId!);
        trace.toolCalls.push({
          name: call.name,
          input: call.input,
          resultPreview: result.result.slice(0, 200),
        });
        messages.push({
          role: 'tool',
          content: result.result,
          toolCallId: result.toolCallId,
          toolName: call.name,
        });
      }
      continue;
    }

    // No tool calls — this should be the final answer
    const text = turn.text ?? '';
    const parsed = parseFeatureJSON(text, req.url);
    return { ...parsed, trace };
  }

  throw new Error('Agent exceeded max iterations without producing a feature');
}

function findJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseFeatureJSON(text: string, url: string): GenerateResponse {
  const trimmed = text.trim();

  // Attempt 1: plain JSON
  const candidates: string[] = [trimmed];

  // Attempt 2: markdown fence
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());

  // Attempt 3: extracted balanced object
  const extracted = findJsonObject(trimmed);
  if (extracted) candidates.push(extracted);

  let obj: any = null;
  for (const c of candidates) {
    try { obj = JSON.parse(c); break; } catch { /* try next */ }
  }
  if (!obj) {
    throw new Error(
      `Agent returned non-JSON final response: ${trimmed.slice(0, 300)}`,
    );
  }
  if (typeof obj.code !== 'string' || !obj.code.trim()) {
    throw new Error('Agent response missing or invalid required field "code"');
  }

  const fallbackPattern = (() => {
    try {
      const u = new URL(url);
      const host = u.hostname;
      // Refuse to default to a global match when hostname extraction fails
      // or the URL has no hostname (e.g. about:blank, chrome://). Pin the
      // pattern to the exact URL so a single feature can't run everywhere.
      if (!host) return url;
      return `*://${host}/*`;
    } catch {
      return url;
    }
  })();

  return {
    code: obj.code,
    name: obj.name || 'Untitled feature',
    description: obj.description || 'Custom customization',
    urlPattern: typeof obj.urlPattern === 'string' && obj.urlPattern
      ? obj.urlPattern
      : fallbackPattern,
  };
}
