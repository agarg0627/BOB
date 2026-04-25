# BOB

A self-customizing browser extension. Press Cmd+K on any webpage,
describe what you want, and an AI agent builds it.

## Setup

```bash
npm install
npm run build
```

Then load `dist/` as an unpacked extension at `chrome://extensions`.

Open the BOB options page (right-click the extension icon → Options)
and paste an API key for one of: Anthropic, OpenAI, or Google. Pick
your provider in the same page. The extension will use that
provider for all feature generation until you change it.

## Dev

```bash
npm run dev        # Vite watch mode
npm run typecheck  # tsc --noEmit
```

## How it works

1. User presses Cmd+K on any page → overlay opens
2. User types a request ("hide the sidebar")
3. Content script captures a pruned DOM snapshot of the current page
4. Background worker sends prompt + snapshot to the configured LLM
5. LLM returns JSON with code, name, description, URL pattern
6. Overlay shows preview; user reviews and clicks Install
7. Feature saved to chrome.storage.local, executed immediately
8. On future visits to matching URLs, content script asks background
   to inject the saved code via chrome.scripting.executeScript with
   world: 'MAIN' (using a Trusted Types policy for compatibility)
9. Popup lists installed features with run/error stats and toggles

## Architecture

    src/
      background/
        index.ts            Service worker, message router
        llm.ts              Provider-agnostic feature generation
        providers/
          anthropic.ts      Anthropic Messages API client
          openai.ts         OpenAI Chat Completions client
          google.ts         Gemini generateContent client
        prompt.ts           Shared system prompt + user prompt builder
        types.ts            Provider interface
        settings.ts         API keys + provider choice persistence
        error-recorder.ts   Per-feature run/error tracking
      content/
        index.ts            Content script entry, runs on every page
        injector.ts         Dispatches feature execution to background
        dom-prune.ts        Compact DOM snapshot for LLM context
        overlay/
          overlay.ts        Cmd+K UI (shadow DOM)
          overlay.css       Overlay styles
          preview.ts        Diff/preview view rendering
      popup/                Installed-features panel with status indicators
      options/              Provider + API key configuration page
      shared/
        types.ts            Locked type contracts
        storage.ts          chrome.storage CRUD for features + settings
        messages.ts         Message-passing helper

## File ownership (Phase 2)

| Person | Files |
|---|---|
| A | `src/background/llm.ts`, `src/background/providers/*`, `src/background/settings.ts`, `src/options/*` |
| B | `src/content/overlay/*`, `src/content/overlay/preview.ts` |
| C | `src/content/dom-prune.ts` |
| D | `src/popup/*`, `src/background/error-recorder.ts` |

Nobody touches `src/background/index.ts`, `src/content/index.ts`,
or `src/content/injector.ts` during Phase 2 development. Those are
integration files — modifications happen only at merge time, by
Person A, using the integration patches each branch provides.

## API key sources

- Anthropic: https://console.anthropic.com/settings/keys
- OpenAI: https://platform.openai.com/api-keys
- Google: https://aistudio.google.com/apikey

## Known limitations

- Sites with strict Trusted Types policies (some Google properties)
  may reject injected scripts. Demo on sites that work; don't fight
  individual sites' CSP.
- Generated code runs in the page's MAIN world and is subject to
  the page's CSP. Most sites work; a few do not.
- No cloud sync. Features and settings live in chrome.storage.local
  on the device they were created on.
