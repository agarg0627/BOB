// Owned by Person D. Phase 1: stub mode with keyword matching.
import type { GenerateRequest, GenerateResponse } from '../shared/types';

/**
 * TODO Phase 2: Replace stub logic with real Claude API call.
 *
 * async function callClaude(req: GenerateRequest): Promise<GenerateResponse> {
 *   const response = await fetch('https://api.anthropic.com/v1/messages', {
 *     method: 'POST',
 *     headers: {
 *       'Content-Type': 'application/json',
 *       'x-api-key': API_KEY,
 *       'anthropic-version': '2023-06-01',
 *     },
 *     body: JSON.stringify({
 *       model: 'claude-sonnet-4-20250514',
 *       max_tokens: 4096,
 *       messages: [{
 *         role: 'user',
 *         content: `You are a browser extension code generator.
 * The user wants: "${req.prompt}"
 * Current page URL: ${req.url}
 * ${req.domSnapshot ? `DOM snapshot:\n${req.domSnapshot}` : ''}
 *
 * Generate a content script that accomplishes the user's request.
 * Return JSON: { "code": "...", "name": "...", "description": "...", "urlPattern": "..." }
 * The code must be a self-executing IIFE wrapped in try/catch.`
 *       }],
 *     }),
 *   });
 *   // Parse response and extract JSON from assistant message
 * }
 */

function wrap(body: string): string {
  return `(function(){ try { ${body} } catch(e){ console.error('[ext]', e); } })();`;
}

function derivePattern(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `*://${host}/*`;
  } catch {
    return '<all_urls>';
  }
}

function matchStub(req: GenerateRequest): GenerateResponse {
  const p = req.prompt.toLowerCase();

  // Rule 1: YouTube Shorts / sidebar
  if (p.includes('youtube') && (p.includes('shorts') || p.includes('sidebar'))) {
    return {
      code: wrap(
        `document.querySelectorAll('ytd-rich-shelf-renderer, ytd-reel-shelf-renderer, [is-shorts]')` +
        `.forEach(function(el){ el.style.display = 'none'; });`
      ),
      name: 'Hide YouTube Shorts',
      description: 'Removes the Shorts shelf from YouTube feed',
      urlPattern: '*://*.youtube.com/*',
    };
  }

  // Rule 2: Background / color change
  if (p.includes('red') || p.includes('background')) {
    return {
      code: wrap(`document.body.style.backgroundColor = '#ffdddd';`),
      name: 'Tint Background',
      description: 'Tints the page background',
      urlPattern: derivePattern(req.url),
    };
  }

  // Rule 3: Default fallback
  return {
    code: wrap(`console.log('[ext] feature ran');`),
    name: 'Custom Feature',
    description: 'A user-defined customization',
    urlPattern: derivePattern(req.url),
  };
}

export async function generateFeature(req: GenerateRequest): Promise<GenerateResponse> {
  // Simulated delay so the overlay loading state is visible during demos
  await new Promise((resolve) => setTimeout(resolve, 600));
  return matchStub(req);
}
