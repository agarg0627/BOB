# Phase 2 — LLM provider integration notes (Person A)

This branch (`feat/llm-providers`) introduces real LLM providers (Anthropic, OpenAI, Google), a settings store, and an options page. The notes below describe the small wire-up required in files I do **not** own.

## `src/background/index.ts` — required changes

Add two new message handlers to the existing `chrome.runtime.onMessage` switch. The `Message` union in `src/shared/types.ts` already declares both variants, so no type changes are needed.

```ts
import { getSettings, setSettings } from './settings';

// inside the existing switch (msg.type) { ... }
case 'GET_SETTINGS': {
  const settings = await getSettings();
  sendResponse(settings);
  break;
}
case 'SET_SETTINGS': {
  const updated = await setSettings(msg.settings);
  sendResponse(updated);
  break;
}
```

The existing `GENERATE_FEATURE` handler needs **no changes** — `generateFeature(req)` keeps the same signature and is drop-in compatible with the previous stub.

## `manifest.json` — no changes needed

- `options_page` already points at `src/options/options.html`.
- `chrome.storage.local` is already permitted via the existing `"storage"` permission.
- No new host permissions are needed; the three provider endpoints are reached via `fetch` from the service worker.

## Manual validation

1. `npx tsc --noEmit` and `npm run build` both succeed.
2. Reload the unpacked extension. Right-click the icon → **Options** opens the new page.
3. Enter a real API key, choose a provider, hit Save → reload the page and confirm values persist.
4. From the service worker console:
   ```js
   await (await import('./llm.js')).generateFeature({
     prompt: 'hide all images on this page',
     url: 'https://example.com',
   });
   ```
   Expect a `{ code, name, description, urlPattern }` object back.
5. With no key set, `generateFeature` throws a clear error that names the options page.
