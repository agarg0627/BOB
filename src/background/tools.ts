import type { ToolCall, ToolResult } from '../shared/types';
import type { ToolDefinition } from './providers/types';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'query_dom',
    description:
      "Query the user's current page and return descriptions of elements matching a CSS selector. Returns up to 10 matches with tag, attributes, text, and child count.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'test_code',
    description:
      "Run JavaScript in the user's tab and return whether it threw an error, plus a brief summary of any DOM changes (added/removed elements counts). Use sparingly.",
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
      },
      required: ['code'],
    },
  },
  {
    name: 'fetch_url',
    description:
      "Fetch the body of a public HTTP(S) URL. Returns the response body as text, capped at 4KB. Use to verify an external URL works, inspect a public API endpoint, or gather context from a public page. NOT for the user's active tab (use query_dom). NOT for URLs requiring auth (no cookies sent).",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
];

// SSRF guard. Applied to the requested hostname AND, after a redirect,
// to the final URL — without the post-redirect re-check, an attacker-
// controlled host could 302 us to a private address.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h === '169.254.169.254'
  ) {
    return true;
  }
  if (h.startsWith('192.168.')) return true;
  if (h.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  return false;
}

// Hard cap on response size. We always read full text() before slicing,
// so a multi-MB body would briefly live in memory before truncation.
// 2 MB is well above what the agent ever needs (4 KB is surfaced) and
// well below anything that would OOM the SW.
const MAX_RESPONSE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_SURFACED_CHARS = 4000;

export async function dispatchTool(
  call: ToolCall,
  tabId: number,
): Promise<ToolResult> {
  try {
    if (call.name === 'query_dom') {
      const sel = String(call.input.selector || '');
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (selector: string) => {
          try {
            const els = Array.from(document.querySelectorAll(selector)).slice(0, 10);
            return els.map((el) => ({
              tag: el.tagName.toLowerCase(),
              attrs: Object.fromEntries(
                Array.from(el.attributes)
                  .slice(0, 6)
                  .map((a) => [a.name, a.value.slice(0, 80)]),
              ),
              text: (el.textContent || '').trim().slice(0, 120),
              childCount: el.children.length,
            }));
          } catch (e) {
            return { error: String(e) };
          }
        },
        args: [sel],
      });
      return {
        toolCallId: call.id,
        result: JSON.stringify(r[0]?.result ?? []).slice(0, 2000),
      };
    }

    if (call.name === 'test_code') {
      const code = String(call.input.code || '');
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (codeStr: string) => {
          const before = document.body.querySelectorAll('*').length;
          let err: string | undefined;
          try {
            const tt = (window as any).trustedTypes;
            let scriptValue: any = codeStr;
            if (tt?.createPolicy) {
              const policy =
                tt.defaultPolicy ??
                tt.createPolicy('bob-test-' + Math.random().toString(36).slice(2), {
                  createScript: (s: string) => s,
                });
              scriptValue = policy.createScript(codeStr);
            }
            const s = document.createElement('script');
            s.textContent = scriptValue;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
            err = (window as any).__bobLastError;
            (window as any).__bobLastError = undefined;
          } catch (e) {
            err = String(e);
          }
          const after = document.body.querySelectorAll('*').length;
          return {
            ok: !err,
            error: err,
            elementsBefore: before,
            elementsAfter: after,
            delta: after - before,
          };
        },
        args: [code],
      });
      return {
        toolCallId: call.id,
        result: JSON.stringify(r[0]?.result ?? {}).slice(0, 1500),
      };
    }

    if (call.name === 'fetch_url') {
      const url = String(call.input.url || '');

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { toolCallId: call.id, result: 'Invalid URL', isError: true };
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          toolCallId: call.id,
          result: 'Only http(s) URLs allowed',
          isError: true,
        };
      }

      if (isBlockedHost(parsed.hostname)) {
        return {
          toolCallId: call.id,
          result: 'Private/internal addresses not allowed',
          isError: true,
        };
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'BOB-Agent/1.0',
              Accept: 'text/html, application/json, text/plain, */*',
            },
          });
        } finally {
          clearTimeout(timeout);
        }

        // Post-redirect re-validation. fetch with redirect:'follow' has
        // already chased 30x; res.url is the final URL the body came
        // from. If a remote host bounced us to a private address, refuse
        // to surface the body to the agent.
        let finalParsed: URL;
        try {
          finalParsed = new URL(res.url);
        } catch {
          return {
            toolCallId: call.id,
            result: 'Final URL invalid after redirect',
            isError: true,
          };
        }
        if (finalParsed.protocol !== 'http:' && finalParsed.protocol !== 'https:') {
          return {
            toolCallId: call.id,
            result: 'Redirect changed protocol away from http(s)',
            isError: true,
          };
        }
        if (isBlockedHost(finalParsed.hostname)) {
          return {
            toolCallId: call.id,
            result: 'Redirect targeted a private/internal address',
            isError: true,
          };
        }

        // Refuse declared-large bodies before reading. Chunked responses
        // with no length header fall through and rely on the 8s timeout.
        const lenHeader = res.headers.get('content-length');
        const declaredLen = lenHeader ? parseInt(lenHeader, 10) : NaN;
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
          return {
            toolCallId: call.id,
            result: `Response too large (${declaredLen} bytes; cap is ${MAX_RESPONSE_BYTES})`,
            isError: true,
          };
        }

        const contentType = res.headers.get('content-type') || 'unknown';
        const text = await res.text();
        const truncated = text.slice(0, MAX_SURFACED_CHARS);
        const summary =
          `HTTP ${res.status} ${res.statusText}\n` +
          `Final URL: ${res.url}\n` +
          `Content-Type: ${contentType}\n` +
          `Length: ${text.length} chars` +
          (text.length > MAX_SURFACED_CHARS ? ` (truncated to ${MAX_SURFACED_CHARS})` : '') +
          '\n\n' +
          truncated;

        return { toolCallId: call.id, result: summary };
      } catch (e) {
        const msg = String(e);
        const isAbort = msg.includes('aborted') || msg.includes('timeout');
        return {
          toolCallId: call.id,
          result: isAbort
            ? `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`
            : `Fetch failed: ${msg}`,
          isError: true,
        };
      }
    }

    return { toolCallId: call.id, result: 'unknown tool', isError: true };
  } catch (e) {
    return { toolCallId: call.id, result: String(e), isError: true };
  }
}
