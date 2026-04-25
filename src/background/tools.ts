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
];

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

    return { toolCallId: call.id, result: 'unknown tool', isError: true };
  } catch (e) {
    return { toolCallId: call.id, result: String(e), isError: true };
  }
}
