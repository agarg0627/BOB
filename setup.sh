#!/usr/bin/env bash
set -euo pipefail

# Sanity check: are we in a git repo?
if [ ! -d .git ]; then
  echo "Error: not in a git repo. cd into your BOB/ clone first."
  exit 1
fi

echo "Setting up BOB repo structure..."

# --- Directories ---
mkdir -p public
mkdir -p src/background
mkdir -p src/content/overlay
mkdir -p src/popup
mkdir -p src/shared
mkdir -p dev

# --- Root config files ---

cat > package.json <<'EOF'
{
  "name": "bob",
  "version": "0.0.1",
  "private": true,
  "description": "BOB — a self-customizing browser extension powered by an AI agent",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.25",
    "@types/chrome": "^0.0.270",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["chrome", "vite/client"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/**/*", "dev/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

cat > vite.config.ts <<'EOF'
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' assert { type: 'json' };

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
EOF

cat > manifest.json <<'EOF'
{
  "manifest_version": 3,
  "name": "BOB",
  "version": "0.0.1",
  "description": "Customize any webpage with natural language.",
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": {
      "16": "public/icon-16.png",
      "48": "public/icon-48.png",
      "128": "public/icon-128.png"
    }
  },
  "icons": {
    "16": "public/icon-16.png",
    "48": "public/icon-48.png",
    "128": "public/icon-128.png"
  },
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "run_at": "document_idle"
    }
  ],
  "permissions": ["storage", "scripting", "activeTab"],
  "host_permissions": ["<all_urls>"]
}
EOF

cat > .gitignore <<'EOF'
node_modules
dist
.DS_Store
.env
.env.local
*.log
.vite
.cache

# Local dev sandboxes (keep out of merges)
dev/*-sandbox.html
dev/*.local.ts
EOF

cat > README.md <<'EOF'
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
EOF

# --- Stub source files (so tsc resolves and merges don't conflict on creation) ---

cat > src/shared/types.ts <<'EOF'
// Owned by Person C. Locked contract — do not modify without team agreement.

export interface Feature {
  id: string;
  name: string;
  userPrompt: string;
  urlPattern: string;
  code: string;
  description: string;
  enabled: boolean;
  createdAt: number;
}

export interface GenerateRequest {
  prompt: string;
  url: string;
  domSnapshot?: string;
  existingCode?: string;
}

export interface GenerateResponse {
  code: string;
  name: string;
  description: string;
  urlPattern: string;
}

export type Message =
  | { type: 'GENERATE_FEATURE'; req: GenerateRequest }
  | { type: 'INSTALL_FEATURE'; feature: Omit<Feature, 'id' | 'createdAt'> }
  | { type: 'GET_FEATURES_FOR_URL'; url: string }
  | { type: 'LIST_FEATURES' }
  | { type: 'DELETE_FEATURE'; id: string }
  | { type: 'TOGGLE_FEATURE'; id: string; enabled: boolean };
EOF

cat > src/shared/storage.ts <<'EOF'
// Owned by Person C. Stub — implement in Phase 1.
import type { Feature } from './types';

export const Storage = {
  async list(): Promise<Feature[]> { throw new Error('not implemented'); },
  async get(_id: string): Promise<Feature | null> { throw new Error('not implemented'); },
  async add(_input: Omit<Feature, 'id' | 'createdAt'>): Promise<Feature> { throw new Error('not implemented'); },
  async update(_id: string, _patch: Partial<Feature>): Promise<void> { throw new Error('not implemented'); },
  async remove(_id: string): Promise<void> { throw new Error('not implemented'); },
  async matching(_url: string): Promise<Feature[]> { throw new Error('not implemented'); },
};
EOF

cat > src/shared/messages.ts <<'EOF'
// Owned by Person C. Stub — implement in Phase 1.
import type { Message } from './types';

export function send<T = unknown>(_msg: Message): Promise<T> {
  throw new Error('not implemented');
}
EOF

cat > src/content/index.ts <<'EOF'
// Owned by Person A. Stub — implement in Phase 1.
console.log('[bob] content script loaded on', location.href);
export {};
EOF

cat > src/content/injector.ts <<'EOF'
// Owned by Person C. Stub — implement in Phase 1.
import type { Feature } from '../shared/types';

export function runFeature(_feature: Feature): { ok: boolean; error?: string } {
  return { ok: false, error: 'not implemented' };
}

export async function runAllForUrl(_url: string): Promise<{ ran: number; errors: string[] }> {
  return { ran: 0, errors: [] };
}
EOF

cat > src/content/overlay/overlay.ts <<'EOF'
// Owned by Person B. Stub — implement in Phase 1.

export interface OverlayCallbacks {
  onSubmit: (prompt: string) => Promise<void>;
}

export function initOverlay(_callbacks: OverlayCallbacks): void {
  // not implemented
}

export function openOverlay(): void {
  // not implemented
}

export function closeOverlay(): void {
  // not implemented
}
EOF

cat > src/content/overlay/overlay.css <<'EOF'
/* Owned by Person B. Stub — implement in Phase 1. */
EOF

cat > src/background/index.ts <<'EOF'
// Owned by Person A. Stub — implement in Phase 1.
console.log('[bob] background started');

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  console.log('[bob] background received message', msg);
  return false;
});

export {};
EOF

cat > src/background/llm.ts <<'EOF'
// Owned by Person D. Stub — implement in Phase 1.
import type { GenerateRequest, GenerateResponse } from '../shared/types';

export async function generateFeature(_req: GenerateRequest): Promise<GenerateResponse> {
  throw new Error('not implemented');
}
EOF

cat > src/popup/popup.html <<'EOF'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>BOB</title>
    <link rel="stylesheet" href="./popup.css" />
  </head>
  <body>
    <div id="root">Loading…</div>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
EOF

cat > src/popup/popup.ts <<'EOF'
// Owned by Person D. Stub — implement in Phase 1.
const root = document.getElementById('root');
if (root) root.textContent = 'BOB — popup not yet implemented';
export {};
EOF

cat > src/popup/popup.css <<'EOF'
/* Owned by Person D. Stub — implement in Phase 1. */
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-width: 360px; }
EOF

# --- Dev sandboxes (gitignored patterns set above; these files are committed as starting points) ---

cat > dev/overlay-test.html <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>BOB — overlay sandbox</title>
</head>
<body>
  <h1>Overlay Sandbox</h1>
  <p>Press Cmd+K (or Ctrl+K) to open the overlay.</p>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
  <script type="module">
    import { initOverlay } from '../src/content/overlay/overlay.ts';
    initOverlay({
      onSubmit: async (prompt) => {
        await new Promise((r) => setTimeout(r, 800));
        console.log('submitted:', prompt);
      },
    });
  </script>
</body>
</html>
EOF

cat > dev/llm-test.ts <<'EOF'
// Person D's local sandbox. Run with: npx tsx dev/llm-test.ts
import { generateFeature } from '../src/background/llm';

const prompts = [
  'hide youtube shorts',
  'make the background red',
  'do something weird',
];

for (const prompt of prompts) {
  try {
    const res = await generateFeature({ prompt, url: 'https://www.youtube.com/' });
    console.log('---', prompt, '---');
    console.log(res);
    new Function(res.code); // syntax check
  } catch (e) {
    console.error('failed for', prompt, e);
  }
}
EOF

# --- Placeholder PNG icons (1x1 transparent) so manifest doesn't break ---
# 67-byte minimal PNG.
ICON_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
echo "$ICON_B64" | base64 --decode > public/icon-16.png
cp public/icon-16.png public/icon-48.png
cp public/icon-16.png public/icon-128.png

echo ""
echo "Repo structure created. Next steps:"
echo "  1. npm install"
echo "  2. npm run typecheck     # should pass with stubs"
echo "  3. npm run build         # should produce dist/"
echo "  4. Load dist/ at chrome://extensions (Developer mode → Load unpacked)"
echo "  5. git add -A && git commit -m 'Phase 0: scaffolding' && git push"
echo "  6. Each person creates their branch:"
echo "       git checkout -b feat/shell      # Person A"
echo "       git checkout -b feat/overlay    # Person B"
echo "       git checkout -b feat/storage    # Person C"
echo "       git checkout -b feat/llm        # Person D"
