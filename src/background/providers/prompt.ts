import type { GenerateRequest, GenerateResponse } from '../../shared/types';

export const SYSTEM_PROMPT = `You are an expert at writing JavaScript content scripts that customize web pages. Given a user request and a pruned snapshot of the page's DOM, produce a small JavaScript snippet.

Output a single JSON object with no markdown, no commentary, no surrounding prose:
{
  "code": "(function(){ try { /* logic */ } catch(e){ console.error('[bob]', e); window.__bobLastError = String(e); } })();",
  "name": "<3-5 word title>",
  "description": "<one sentence>",
  "urlPattern": "<glob like *://*.youtube.com/*>"
}

Rules:
- Wrap all logic in the IIFE + try/catch shown above. The catch block must set window.__bobLastError = String(e) so the extension can detect runtime failures.
- Be idempotent: re-running the snippet must not duplicate effects. Tag any element you inject with data-bob="<feature-name-slug>" and check for its existence before re-creating.
- Prefer stable selectors: aria-label, role, data-testid, semantic tags. Avoid auto-generated class names like "css-1a2b3c".
- For dynamically rendered pages, use MutationObserver to reapply changes when new nodes appear.
- Do NOT use eval, new Function, document.write, or innerHTML for executable content.
- Keep the code under 100 lines.`;

export function buildUserPrompt(req: GenerateRequest): string {
  const parts: string[] = [];
  parts.push(`User request:\n${req.prompt}`);
  parts.push(`Current URL:\n${req.url}`);
  if (req.domSnapshot) {
    parts.push(`Pruned DOM snapshot:\n${req.domSnapshot}`);
  }
  if (req.existingCode) {
    parts.push(
      `Existing code (iterate on this; preserve what works, fix what's broken):\n${req.existingCode}`,
    );
  }
  return parts.join('\n\n');
}

export function parseAndValidate(providerName: string, rawText: string, req: GenerateRequest): GenerateResponse {
  const cleaned = stripFences(rawText).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `${providerName}: response was not valid JSON (${(e as Error).message}). First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${providerName}: response JSON was not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.code !== 'string' || obj.code.length === 0) {
    throw new Error(`${providerName}: response missing field "code"`);
  }
  const hostname = (() => {
    try { return new URL(req.url).hostname; } catch { return '*'; }
  })();
  return {
    code: obj.code,
    name: typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : 'Untitled feature',
    description: typeof obj.description === 'string' && obj.description.length > 0 ? obj.description : 'Custom customization',
    urlPattern: typeof obj.urlPattern === 'string' && obj.urlPattern.length > 0 ? obj.urlPattern : `*://${hostname}/*`,
  };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) return fenceMatch[1];
  return trimmed;
}
