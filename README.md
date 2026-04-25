# BOB

A self-customizing browser extension. Press Cmd+K on any webpage,
describe what you want, and an AI agent builds it.

## Setup
```bash
npm install
npm run build
```
Then load `dist/` as an unpacked extension at `chrome://extensions`.

## Dev
```bash
npm run dev        # Vite watch mode
npm run typecheck  # tsc --noEmit
```

## Architecture (Phase 1)
- `src/content/index.ts` — content script entry, runs on every page
- `src/content/overlay/` — Cmd+K prompt UI (shadow DOM)
- `src/content/injector.ts` — runs installed features on page load
- `src/background/index.ts` — service worker, message router
- `src/background/llm.ts` — feature generation (stub in Phase 1)
- `src/popup/` — installed-features panel
- `src/shared/` — types, storage, message helpers

## File Ownership (Phase 1)
| Person | Files |
|---|---|
| A | manifest.json, package.json, vite.config.ts, tsconfig.json, src/background/index.ts, src/content/index.ts |
| B | src/content/overlay/* |
| C | src/shared/*, src/content/injector.ts |
| D | src/background/llm.ts, src/popup/* |

Do not edit files outside your column during Phase 1.
