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

---

# Phase 2 — Overlay diff/preview integration notes (Person B)

The overlay (`src/content/overlay/overlay.ts`) now has a preview step between generate and install. **The `OverlayCallbacks` shape is a breaking change** — the merger must update `src/content/index.ts` before the content script will compile.

## `src/content/overlay/overlay.ts` — new public API

```ts
export interface OverlayCallbacks {
  onGenerate: (prompt: string) => Promise<GenerateResponse>;
  onInstall: (feature: GenerateResponse & { userPrompt: string }) => Promise<void>;
}

export function initOverlay(cb: OverlayCallbacks): void;
export function openOverlay(): void;
export function closeOverlay(): void;
```

State machine: `closed → open → loading → preview → installing → closed` (with `Cancel` returning `preview → open` with the original prompt pre-filled, and either error path returning to its prior state with an inline error message).

## `src/content/index.ts` — required changes

Replace the existing `initOverlay({ onSubmit })` block with the two-callback shape:

```ts
initOverlay({
  onGenerate: async (prompt) => {
    const domSnapshot = prunePage(); // Person C's module
    const response = await send<GenerateResponse & { error?: string }>({
      type: 'GENERATE_FEATURE',
      req: { prompt, url: location.href, domSnapshot },
    });
    if (response.error) throw new Error(response.error);
    return response;
  },
  onInstall: async (feature) => {
    const installed = await send<Feature>({
      type: 'INSTALL_FEATURE',
      feature: { ...feature, enabled: true, runCount: 0, errorCount: 0 },
    });
    await send({ type: 'RUN_FEATURE', featureId: installed.id, code: installed.code });
  },
});
```

Note: `onInstall`'s argument already includes `userPrompt` (set by the overlay from the original prompt before any preview edits), so the merger does **not** need to pass it separately.

## Why `tsc --noEmit` currently fails

Until the merger applies the snippet above, `src/content/index.ts` still references the old `onSubmit` field and will produce one TS error:

```
src/content/index.ts: 'onSubmit' does not exist in type 'OverlayCallbacks'.
```

`npm run build` (Vite) succeeds — Vite transpiles without typechecking — and the rest of the codebase (overlay, preview, providers, settings, options) is clean.

## Manual validation (overlay)

1. `npm run dev`, open `http://localhost:5173/dev/overlay-test.html`.
2. Press ⌘K → type a prompt → Enter. Loading spinner shows for ~800ms, then the preview view appears with editable name/url, read-only description, and syntax-highlighted code.
3. Click **Install** (or press ⌘↵). Spinner on the button, then overlay closes and the success toast appears bottom-right for ~2.5s.
4. Click **Cancel** → returns to prompt with original text pre-filled, ready to edit.
5. Type a prompt containing `error-gen` → onGenerate throws → error appears inline in the prompt area, prompt text preserved.
6. From the preview, edit the name to include `error-install` → click Install → error appears in the preview area, Install button re-enables.
7. Press **Esc** at any state — overlay closes; in-flight requests are discarded via a request-token guard so a stale response can't resurface the preview.
8. Verify shadow DOM isolation by manually injecting the built content script (`dist/assets/index.ts-*.js`) on a strict CSP host like `github.com` via DevTools and confirming the modal renders unstyled-by-host.

