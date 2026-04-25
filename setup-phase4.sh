#!/usr/bin/env bash
# setup-phase4.sh — Phase 4 setup: type contracts, model upgrades, defaults
set -euo pipefail

if [ ! -d .git ]; then
  echo "Error: not in a git repo. cd into BOB/ first."
  exit 1
fi
if [ ! -f src/shared/types.ts ]; then
  echo "Error: src/shared/types.ts not found. Phase 3 must be merged first."
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash first."
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Error: not on main (current: $CURRENT_BRANCH). Switch first."
  exit 1
fi

echo "Phase 4 setup..."

# --- Patch src/shared/types.ts (additive only) ---
python3 <<'PYEOF'
import re
from pathlib import Path

p = Path("src/shared/types.ts")
src = p.read_text()

# 1. Add EffortMode after LLMProvider
if 'EffortMode' in src:
    print("  EffortMode already present — skipping")
else:
    m = re.search(r"(export type LLMProvider[^;]+;)", src)
    if not m:
        raise SystemExit("Could not find LLMProvider declaration")
    insertion = "\n\nexport type EffortMode = 'standard' | 'high';"
    src = src[:m.end()] + insertion + src[m.end():]
    print("  EffortMode added")

# 2. Extend ExtensionSettings with effortMode
m = re.search(r'(export interface ExtensionSettings\s*\{)([^}]*)(\})', src, re.DOTALL)
if not m:
    raise SystemExit("Could not find ExtensionSettings")
if 'effortMode' in m.group(2):
    print("  ExtensionSettings.effortMode already present — skipping")
else:
    body = m.group(2).rstrip()
    new_body = body + "\n  effortMode?: EffortMode;\n"
    src = src[:m.start()] + m.group(1) + new_body + m.group(3) + src[m.end():]
    print("  ExtensionSettings extended")

# 3. Extend Suggestion with dismissalState + laterUntil
m = re.search(r'(export interface Suggestion\s*\{)([^}]*)(\})', src, re.DOTALL)
if not m:
    raise SystemExit("Could not find Suggestion")
if 'dismissalState' in m.group(2):
    print("  Suggestion.dismissalState already present — skipping")
else:
    body = m.group(2).rstrip()
    new_body = body + "\n  dismissalState?: 'none' | 'later' | 'never';\n  laterUntil?: number;\n"
    src = src[:m.start()] + m.group(1) + new_body + m.group(3) + src[m.end():]
    print("  Suggestion extended")

# 4. Extend GenerateRequest with effortMode + refinementHistory
m = re.search(r'(export interface GenerateRequest\s*\{)([^}]*)(\})', src, re.DOTALL)
if not m:
    raise SystemExit("Could not find GenerateRequest")
if 'refinementHistory' in m.group(2):
    print("  GenerateRequest.refinementHistory already present — skipping")
else:
    body = m.group(2).rstrip()
    new_body = body + "\n  effortMode?: EffortMode;\n  refinementHistory?: { role: 'user' | 'assistant'; content: string }[];\n"
    src = src[:m.start()] + m.group(1) + new_body + m.group(3) + src[m.end():]
    print("  GenerateRequest extended")

# 5. Extend Message union with new variants
m = re.search(r'export type Message\s*=\s*([\s\S]*?);', src)
if not m:
    raise SystemExit("Could not find Message union")
existing = m.group(1)
if "GET_SUGGESTIONS_VISIBLE" in existing:
    print("  Message union already has Phase 4 variants — skipping")
else:
    additions = """  | { type: 'GET_SUGGESTIONS_VISIBLE'; hostname?: string }
  | { type: 'SET_SUGGESTION_STATE'; id: string; state: 'none' | 'later' | 'never' }
  | { type: 'EXPORT_FEATURES' }
  | { type: 'IMPORT_FEATURES'; json: string; mode: 'merge' | 'replace' }"""
    union_body = existing.rstrip()
    new_union = "export type Message =\n" + union_body + "\n" + additions
    src = src[:m.start()] + new_union + ";" + src[m.end():]
    print("  Message union extended")

p.write_text(src)
print("  types.ts done")
PYEOF

# --- Patch src/background/settings.ts (DEFAULT_SETTINGS) ---
python3 <<'PYEOF'
import re
from pathlib import Path

p = Path("src/background/settings.ts")
if not p.exists():
    print("  WARN: src/background/settings.ts not found — Phase 2 must have shipped it. Skipping.")
else:
    src = p.read_text()
    if "effortMode" in src:
        print("  settings.ts already has effortMode — skipping")
    else:
        # Find DEFAULT_SETTINGS object literal
        m = re.search(r'(export const DEFAULT_SETTINGS[^=]*=\s*\{)([^}]*)(\})', src, re.DOTALL)
        if not m:
            print("  WARN: Could not find DEFAULT_SETTINGS literal in settings.ts — skipping. Pair 2 will need to add effortMode default manually.")
        else:
            body = m.group(2).rstrip()
            # Strip trailing comma if present, we'll add one
            if body.endswith(','):
                body = body[:-1]
            new_body = body + ",\n  effortMode: 'standard',\n"
            src = src[:m.start()] + m.group(1) + new_body + m.group(3) + src[m.end():]
            p.write_text(src)
            print("  settings.ts DEFAULT_SETTINGS extended")
PYEOF

# --- Bump model defaults in providers ---
python3 <<'PYEOF'
import re
from pathlib import Path

UPDATES = [
    ("src/background/providers/anthropic.ts", "claude-sonnet-4-6"),
    ("src/background/providers/openai.ts",    "gpt-5.5"),
    ("src/background/providers/google.ts",    "gemini-3.1-pro-preview"),
]

for path_str, new_model in UPDATES:
    p = Path(path_str)
    if not p.exists():
        print(f"  WARN: {path_str} not found — skipping model bump")
        continue
    src = p.read_text()
    m = re.search(r"(defaultModel\s*:\s*['\"])([^'\"]+)(['\"])", src)
    if not m:
        print(f"  WARN: defaultModel not found in {path_str} — skipping")
        continue
    if m.group(2) == new_model:
        print(f"  {path_str}: already on {new_model}")
        continue
    src = src[:m.start()] + m.group(1) + new_model + m.group(3) + src[m.end():]
    p.write_text(src)
    print(f"  {path_str}: {m.group(2)} -> {new_model}")
PYEOF

# --- Update README ---
python3 <<'PYEOF'
import re
from pathlib import Path

p = Path("README.md")
if not p.exists():
    print("  README.md not found, skipping")
else:
    src = p.read_text()
    new_table = '''## File ownership (Phase 4)

| Pair | Files |
|---|---|
| 1 (Frontend) | `src/content/overlay/*` (extend), `src/popup/popup.ts` and `popup.css` (extend), `src/popup/suggestions-section.ts` (extend), `src/options/options.ts` (extend), `src/content/page-badge.ts`, `src/content/voice-input.ts`, `src/popup/import-export.ts` |
| 2 (Backend) | `src/background/providers/prompt.ts` (rewrite), `src/background/providers/{anthropic,openai,google}.ts` (extend for high-effort), `src/background/agent.ts` (extend for refinement + effort), `src/background/suggestions-engine.ts` (three-state dismissal, dedup), `src/background/settings.ts` (effort mode) |

Untouchable during Phase 4 dev: `src/background/index.ts`, `src/content/index.ts`, `src/content/injector.ts`, `src/shared/types.ts`, `src/shared/storage.ts`. Modified at integration only.

## Model defaults (Phase 4)

- Anthropic: `claude-sonnet-4-6`
- OpenAI: `gpt-5.5`
- Google: `gemini-3.1-pro-preview`'''

    src_new = re.sub(
        r'## File ownership[^\n]*\n.*?(?=\n## |\Z)',
        new_table + "\n",
        src,
        count=1,
        flags=re.DOTALL,
    )
    if src_new == src:
        src_new = src.rstrip() + "\n\n" + new_table + "\n"
    p.write_text(src_new)
    print("  README.md updated")
PYEOF

# --- Validate ---
echo ""
echo "Running typecheck..."
if ! npm run typecheck; then
  echo ""
  echo "Typecheck FAILED. Most likely cause: existing code constructs"
  echo "Suggestion or ExtensionSettings literals without the new optional"
  echo "fields. Since they're all optional (?), this should NOT happen."
  echo "Read the errors and fix or revert."
  exit 1
fi

echo ""
echo "Running build..."
if ! npm run build; then
  echo ""
  echo "Build FAILED. Read the errors. Do NOT commit."
  exit 1
fi

echo ""
echo "Phase 4 setup complete. Review the diff:"
echo "  git diff --stat"
echo "  git diff src/shared/types.ts"
echo "  git diff src/background/settings.ts"
echo "  git diff src/background/providers/"
echo "  git diff README.md"
echo ""
echo "Then commit:"
echo "  git add -A"
echo "  git commit -m 'Phase 4 setup: type contracts, model upgrades, defaults'"
echo "  git push origin main"
echo ""
echo "Then pairs pull and create branches:"
echo "  git checkout -b feat/p4-frontend  # Pair 1"
echo "  git checkout -b feat/p4-backend   # Pair 2"