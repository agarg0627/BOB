/*
=== INTEGRATION PATCHES (for the merger) ===

These changes are required in files Pair 2 does not own. The Pair 2
branch only typechecks against the additions because the new Message
variants are already declared in src/shared/types.ts.

1. src/background/index.ts — add the following message handlers inside
   the existing chrome.runtime.onMessage switch:

     case 'GET_SUGGESTIONS_VISIBLE': {
       const list = await getVisibleSuggestions(msg.hostname);
       sendResponse(list);
       break;
     }
     case 'SET_SUGGESTION_STATE': {
       await setSuggestionState(msg.id, msg.state);
       sendResponse({ ok: true });
       break;
     }
     case 'EXPORT_FEATURES': {
       const all = await Storage.list();
       const json = JSON.stringify({
         version: 1,
         exportedAt: Date.now(),
         features: all,
       }, null, 2);
       sendResponse({ json });
       break;
     }
     case 'IMPORT_FEATURES': {
       const parsed = JSON.parse(msg.json);
       if (!parsed.features || !Array.isArray(parsed.features)) {
         sendResponse({ error: 'Invalid format' });
         break;
       }
       if (msg.mode === 'replace') {
         const existing = await Storage.list();
         for (const f of existing) await Storage.remove(f.id);
       }
       let count = 0;
       for (const f of parsed.features) {
         const { id, createdAt, ...rest } = f;
         await Storage.add(rest);
         count++;
       }
       sendResponse({ count });
       break;
     }

   The setSuggestionState / getVisibleSuggestions imports come from
   './suggestions-engine' alongside the existing
   getSuggestions / dismissSuggestion / acceptSuggestion imports.

2. src/background/index.ts — the existing GENERATE_FEATURE handler
   already does `const req = { ...msg.req, tabId };` which forwards the
   new optional fields (effortMode, refinementHistory) without change.
   Confirm this; no code change needed if it still spreads msg.req.

3. src/popup/popup.ts — bulk action handlers should reload the active
   tab if it matches any feature's pattern. After BULK_TOGGLE /
   BULK_DELETE succeeds, send to active tab:

     const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
     if (tab?.id) chrome.tabs.reload(tab.id);

   Pair 1 owns popup.ts; this is for them to wire (they may already be
   doing it via maybeReloadActiveTab on each affected feature).
*/

import type { GenerateRequest, GenerateResponse, AgentTrace } from '../shared/types';

export type AgentProgressEvent =
  | { type: 'iteration'; n: number; total: number }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; preview: string }
  | { type: 'thinking'; text: string }
  | { type: 'final' };

export type ProgressCallback = (e: AgentProgressEvent) => void;
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

// Standard mode caps iterations at 6. High-effort mode doubles the
// cap because extended-thinking turns can spend multiple iterations on
// plan exploration before the first tool call, and we want to keep
// headroom for the subsequent tool-use cycles.
function humanizeError(rawMessage: string): string {
  const msg = rawMessage.toLowerCase();

  if (msg.includes('no api key') || msg.includes('api key not')) {
    return "I'm not configured yet \u2014 add an API key in Settings.";
  }
  if (msg.includes('exceeded max iterations')) {
    return "I tried hard but couldn't quite get this one. Try being more specific, or simplify the request.";
  }
  if (msg.includes('non-json final response')) {
    return 'I got confused mid-task. Try rephrasing the request.';
  }
  if (msg.includes('rate limit') || msg.includes('429')) {
    if (msg.includes('credits are depleted') || msg.includes('quota')) {
      return "Your API key has run out of credits or quota. Check " +
        "your provider's billing or quota page.";
    }
    return "The AI service is rate-limiting me. Wait a moment " +
      "and try again.";
  }
  if (msg.includes('quota') || msg.includes('insufficient_quota')) {
    return 'Your API key has run out of quota. Check your provider\u2019s billing page.';
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('authentication')) {
    return "Your API key isn't working. Check it in Settings.";
  }
  if (msg.includes('cors') || msg.includes('failed to fetch')) {
    return "I couldn't reach the AI service. Check your internet connection.";
  }
  return rawMessage;
}

const STANDARD_MAX_ITERATIONS = 6;
const HIGH_EFFORT_MAX_ITERATIONS = 12;

export async function runAgent(
  req: GenerateRequest,
  onProgress?: ProgressCallback,
): Promise<GenerateResponse & { trace: AgentTrace }> {
  const settings = await getSettings();
  const provider = PROVIDERS[settings.provider];
  const apiKey = settings.apiKeys[settings.provider];
  if (!apiKey) {
    const raw = `No API key for ${provider.name}. Open BOB options.`;
    console.warn('[bob] agent error:', raw);
    throw new Error(humanizeError(raw));
  }

  // Effort mode resolution: an explicit per-request override wins, then
  // the saved setting, then 'standard'.
  const effortMode = req.effortMode ?? settings.effortMode ?? 'standard';
  const maxIterations =
    effortMode === 'high' ? HIGH_EFFORT_MAX_ITERATIONS : STANDARD_MAX_ITERATIONS;

  const messages: ProviderMessage[] = [
    { role: 'user', content: buildUserPrompt(req) },
  ];
  const trace: AgentTrace = { iterations: 0, toolCalls: [], retries: 0 };

  // Tools only available if we have a tabId (so the agent can act
  // on the user's tab). Without one, fall back to non-tool generation.
  const tools = req.tabId !== undefined ? [...TOOL_DEFINITIONS] : [];

  for (let i = 0; i < maxIterations; i++) {
    trace.iterations++;
    onProgress?.({ type: 'iteration', n: i + 1, total: maxIterations });

    let turn;
    try {
      turn = await provider.chat({
        messages,
        system: SYSTEM_PROMPT,
        tools,
        apiKey,
        model: settings.model,
        effortMode,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.warn('[bob] provider error:', raw);
      throw new Error(humanizeError(raw));
    }

    if (turn.thinkingText) {
      onProgress?.({ type: 'thinking', text: turn.thinkingText });
    }

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      // Append assistant turn with tool calls
      messages.push({
        role: 'assistant',
        content: turn.text || '',
        toolCalls: turn.toolCalls,
      });
      // Dispatch each tool, append tool_result messages
      for (const call of turn.toolCalls) {
        onProgress?.({ type: 'tool_call', name: call.name, input: call.input });
        const result = await dispatchTool(call, req.tabId!);
        onProgress?.({ type: 'tool_result', name: call.name, preview: result.result.slice(0, 100) });
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
    onProgress?.({ type: 'final' });
    const text = turn.text ?? '';
    try {
      const parsed = parseFeatureJSON(text, req.url);
      return { ...parsed, trace };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.warn('[bob] parse error:', raw);
      throw new Error(humanizeError(raw));
    }
  }

  const raw = `Agent exceeded max iterations (${maxIterations}, effortMode=${effortMode}) without producing a feature`;
  console.warn('[bob] agent error:', raw);
  throw new Error(humanizeError(raw));
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
