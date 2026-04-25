#!/usr/bin/env bash
set -euo pipefail

# Sanity checks
if [ ! -d .git ]; then
  echo "Error: not in a git repo. cd into BOB/ first."
  exit 1
fi
if [ ! -f src/shared/types.ts ]; then
  echo "Error: src/shared/types.ts not found. Are you on main with Phase 2 merged?"
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash first."
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Error: not on main (current: $CURRENT_BRANCH). Switch to main first."
  exit 1
fi

echo "Phase 3 setup: extending types.ts and storage.ts..."

# --- Patch src/shared/types.ts ---
# We append new types and extend existing interfaces. Because the
# existing file already defines Feature, GenerateRequest, and Message,
# we replace those three blocks via Python (sed is unreliable for
# multi-line replacements with curly braces).

python3 <<'PYEOF'
import re
from pathlib import Path

p = Path("src/shared/types.ts")
src = p.read_text()

# 1. Append new top-level types after the LLMProvider/ExtensionSettings block.
new_top_types = '''
export interface ToolCall {
  id: string;
  name: 'query_dom' | 'test_code';
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export interface AgentTrace {
  iterations: number;
  toolCalls: { name: string; input: unknown; resultPreview: string }[];
  retries: number;
}

export interface UserBehaviorEvent {
  type: 'click_close' | 'click_dismiss' | 'hide_element' | 'time_on_site';
  url: string;
  hostname: string;
  selector?: string;
  text?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Suggestion {
  id: string;
  hostname: string;
  proposedPrompt: string;
  rationale: string;
  confidence: number;
  evidenceCount: number;
  createdAt: number;
  dismissed?: boolean;
}
'''

# Insert new top-level types after the ExtensionSettings interface.
# Find the closing brace of ExtensionSettings.
m = re.search(r'(export interface ExtensionSettings\s*\{[^}]*\})', src, re.DOTALL)
if not m:
    raise SystemExit("Could not find ExtensionSettings interface in types.ts")
src = src[:m.end()] + "\n" + new_top_types + src[m.end():]

# 2. Extend Feature interface — add new fields before the closing brace.
feature_extension = '''  parentFeatureId?: string;
  iterationNumber?: number;
  agentTrace?: AgentTrace;
'''
m = re.search(r'(export interface Feature\s*\{)([^}]*)(\})', src, re.DOTALL)
if not m:
    raise SystemExit("Could not find Feature interface in types.ts")
existing_body = m.group(2)
if 'parentFeatureId' in existing_body:
    print("  Feature already has parentFeatureId — skipping interface extension")
else:
    src = src[:m.start()] + m.group(1) + existing_body.rstrip() + "\n" + feature_extension + m.group(3) + src[m.end():]

# 3. Extend GenerateRequest — add new fields.
genreq_extension = '''  existingFeatureName?: string;
  previousError?: string;
  tabId?: number;
'''
m = re.search(r'(export interface GenerateRequest\s*\{)([^}]*)(\})', src, re.DOTALL)
if not m:
    raise SystemExit("Could not find GenerateRequest interface in types.ts")
existing_body = m.group(2)
if 'previousError' in existing_body:
    print("  GenerateRequest already has previousError — skipping interface extension")
else:
    src = src[:m.start()] + m.group(1) + existing_body.rstrip() + "\n" + genreq_extension + m.group(3) + src[m.end():]

# 4. Extend Message union — add new variants before the final semicolon.
message_extensions = '''  | { type: 'TOOL_QUERY_DOM'; selector: string; tabId: number }
  | { type: 'TOOL_TEST_CODE'; code: string; tabId: number }
  | { type: 'TRACK_BEHAVIOR'; event: UserBehaviorEvent }
  | { type: 'GET_SUGGESTIONS'; hostname?: string }
  | { type: 'DISMISS_SUGGESTION'; id: string }
  | { type: 'ACCEPT_SUGGESTION'; id: string }
  | { type: 'BULK_TOGGLE'; enabled: boolean }
  | { type: 'BULK_DELETE' }
  | { type: 'OPEN_OVERLAY_FOR_EDIT'; featureId: string };'''

# Find "export type Message = ... ;" (could span many lines)
m = re.search(r'export type Message\s*=\s*([\s\S]*?);', src)
if not m:
    raise SystemExit("Could not find Message union in types.ts")
existing_union = m.group(1)
if "'TRACK_BEHAVIOR'" in existing_union:
    print("  Message union already has Phase 3 variants — skipping extension")
else:
    # Strip the trailing semicolon-context and append our variants
    union_without_semi = existing_union.rstrip()
    new_union = "export type Message =\n" + union_without_semi + "\n" + message_extensions
    src = src[:m.start()] + new_union + src[m.end():]

p.write_text(src)
print("  types.ts updated")
PYEOF

# --- Patch src/shared/storage.ts ---
# Append Behavior and Suggestions modules to the end of the file.

python3 <<'PYEOF'
from pathlib import Path

p = Path("src/shared/storage.ts")
src = p.read_text()

if 'BEHAVIOR_KEY' in src:
    print("  storage.ts already has Behavior module — skipping")
else:
    # Make sure UserBehaviorEvent and Suggestion are imported from types.
    # The existing file imports Feature; we add to that import.
    import re
    m = re.search(r"import type \{([^}]+)\} from ['\"]\./types['\"];", src)
    if m:
        existing_imports = m.group(1)
        needed = ['Feature', 'UserBehaviorEvent', 'Suggestion']
        merged = sorted(set([s.strip() for s in existing_imports.split(',')] + needed))
        merged = [s for s in merged if s]  # drop empty
        new_import = f"import type {{ {', '.join(merged)} }} from './types';"
        src = src[:m.start()] + new_import + src[m.end():]
    else:
        # No existing import; prepend one.
        src = "import type { Feature, UserBehaviorEvent, Suggestion } from './types';\n" + src

    addendum = '''

// --- Phase 3: Behavior tracking and Suggestions ---

const BEHAVIOR_KEY = 'behavior';
const SUGGESTIONS_KEY = 'suggestions';
const MAX_BEHAVIOR_EVENTS = 500;

export const Behavior = {
  async append(event: UserBehaviorEvent): Promise<void> {
    const stored = (await chrome.storage.local.get(BEHAVIOR_KEY))[BEHAVIOR_KEY];
    const all = (Array.isArray(stored) ? stored : []) as UserBehaviorEvent[];
    all.push(event);
    if (all.length > MAX_BEHAVIOR_EVENTS) {
      all.splice(0, all.length - MAX_BEHAVIOR_EVENTS);
    }
    await chrome.storage.local.set({ [BEHAVIOR_KEY]: all });
  },
  async list(hostname?: string): Promise<UserBehaviorEvent[]> {
    const stored = (await chrome.storage.local.get(BEHAVIOR_KEY))[BEHAVIOR_KEY];
    const all = (Array.isArray(stored) ? stored : []) as UserBehaviorEvent[];
    return hostname ? all.filter((e) => e.hostname === hostname) : all;
  },
  async clear(): Promise<void> {
    await chrome.storage.local.set({ [BEHAVIOR_KEY]: [] });
  },
};

export const Suggestions = {
  async list(): Promise<Suggestion[]> {
    const stored = (await chrome.storage.local.get(SUGGESTIONS_KEY))[SUGGESTIONS_KEY];
    return (Array.isArray(stored) ? stored : []) as Suggestion[];
  },
  async upsert(s: Suggestion): Promise<void> {
    const all = await Suggestions.list();
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s;
    else all.push(s);
    await chrome.storage.local.set({ [SUGGESTIONS_KEY]: all });
  },
  async remove(id: string): Promise<void> {
    const all = await Suggestions.list();
    await chrome.storage.local.set({
      [SUGGESTIONS_KEY]: all.filter((s) => s.id !== id),
    });
  },
  async clear(): Promise<void> {
    await chrome.storage.local.set({ [SUGGESTIONS_KEY]: [] });
  },
};
'''
    src = src.rstrip() + "\n" + addendum
    Path("src/shared/storage.ts").write_text(src)
    print("  storage.ts updated")
PYEOF

# --- Update README ---
python3 <<'PYEOF'
from pathlib import Path
import re

p = Path("README.md")
if not p.exists():
    print("  README.md not found, skipping")
else:
    src = p.read_text()
    # Replace the File ownership table with Phase 3 owners.
    new_table = '''## File ownership (Phase 3)

| Person | Files |
|---|---|
| A | `src/background/agent.ts`, `src/background/tools.ts`, `src/background/providers/*` (extend for tool use), `src/background/providers/prompt.ts` (rewrite), `src/background/llm.ts` (extend) |
| B | `src/content/spa.ts`, `src/content/observer-helper.ts`, `src/content/lifecycle.ts` |
| C | `src/background/suggestions-engine.ts`, `src/content/behavior-tracker.ts`, `src/popup/suggestions-section.ts`, `src/popup/suggestions-section.css` |
| D | `src/content/overlay/*` (extend), `src/popup/popup.ts` and `popup.css` (extend), `src/popup/iteration.ts` |

Untouchable during Phase 3 dev: `src/background/index.ts`, `src/content/index.ts`, `src/content/injector.ts`. Modified at integration only.'''

    # Replace any existing "## File ownership" section.
    src_new = re.sub(
        r'## File ownership[^\n]*\n.*?(?=\n## |\Z)',
        new_table + "\n",
        src,
        count=1,
        flags=re.DOTALL,
    )
    if src_new == src:
        # No existing section — append.
        src_new = src.rstrip() + "\n\n" + new_table + "\n"
    p.write_text(src_new)
    print("  README.md updated")
PYEOF

# --- Validate ---
echo ""
echo "Running typecheck..."
if ! npm run typecheck; then
  echo ""
  echo "Typecheck FAILED. Read the errors above. Most likely cause:"
  echo "existing code references the new fields with wrong shape."
  echo "Do NOT commit. Fix or revert."
  exit 1
fi

echo ""
echo "Running build..."
if ! npm run build; then
  echo ""
  echo "Build FAILED. Read the errors above. Do NOT commit."
  exit 1
fi

echo ""
echo "Phase 3 setup complete. Review the diff:"
echo "  git diff --stat"
echo "  git diff src/shared/types.ts src/shared/storage.ts README.md"
echo ""
echo "Then commit:"
echo "  git add -A"
echo "  git commit -m 'Phase 3 setup: type contracts and storage extensions'"
echo "  git push origin main"
echo ""
echo "Then everyone pulls and creates branches:"
echo "  git checkout -b feat/agent       # Person A"
echo "  git checkout -b feat/reactive    # Person B"
echo "  git checkout -b feat/suggestions # Person C"
echo "  git checkout -b feat/iter-polish # Person D"