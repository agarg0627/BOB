// Conflict detection for keyboard shortcuts. Two sources:
//
//  1. Chrome browser reserved combos. The user can technically bind to
//     them, but the browser's handler runs first and our listener
//     usually never fires (or fires alongside the browser action,
//     which is jarring). We warn the user up-front.
//
//  2. Other bindings inside the extension. The three Settings keybinds
//     (open / refine-last / quick-toggle) plus every feature's per-
//     feature hotkey share the same global keydown space.
//
// Hotkey strings here use the canonical form produced by
// shared/hotkey.ts: modifiers in fixed order ("Ctrl+Shift+Alt+<KEY>"),
// Cmd normalized to Ctrl, single keys upper-cased. So "Ctrl+T" matches
// both Cmd+T (Mac) and Ctrl+T (Windows / Linux).

// Subset that's reserved on most Chromium browsers across major
// platforms. Not exhaustive — high-frequency / high-impact only.
// Each entry maps the canonical combo to a short description we can
// surface in the warning copy.
export const CHROME_RESERVED_HOTKEYS: Record<string, string> = {
  'Ctrl+T': 'New tab',
  'Ctrl+W': 'Close tab',
  'Ctrl+N': 'New window',
  'Ctrl+Shift+T': 'Reopen closed tab',
  'Ctrl+Shift+N': 'New incognito window',
  'Ctrl+L': 'Focus address bar',
  'Ctrl+R': 'Reload page',
  'Ctrl+Shift+R': 'Hard reload',
  'Ctrl+F': 'Find on page',
  'Ctrl+G': 'Find next',
  'Ctrl+Shift+G': 'Find previous',
  'Ctrl+P': 'Print',
  'Ctrl+S': 'Save page',
  'Ctrl+D': 'Bookmark page',
  'Ctrl+Shift+D': 'Bookmark all tabs',
  'Ctrl+Shift+B': 'Toggle bookmarks bar',
  'Ctrl+Shift+O': 'Bookmark manager',
  'Ctrl+H': 'History (or Hide window on Mac)',
  'Ctrl+J': 'Downloads',
  'Ctrl+Shift+J': 'Downloads (Mac)',
  'Ctrl+Y': 'History (Mac)',
  'Ctrl+Q': 'Quit',
  'Ctrl+M': 'Minimize (Mac)',
  'Ctrl+O': 'Open file',
  'Ctrl+E': 'Search using selection',
  'Ctrl+Shift+E': 'Search history',
  'Ctrl+U': 'View source',
  'Ctrl+Tab': 'Next tab',
  'Ctrl+Shift+Tab': 'Previous tab',
  'Ctrl+1': 'Tab 1',
  'Ctrl+2': 'Tab 2',
  'Ctrl+3': 'Tab 3',
  'Ctrl+4': 'Tab 4',
  'Ctrl+5': 'Tab 5',
  'Ctrl+6': 'Tab 6',
  'Ctrl+7': 'Tab 7',
  'Ctrl+8': 'Tab 8',
  'Ctrl+9': 'Last tab',
  'Ctrl+0': 'Reset zoom',
  'Ctrl++': 'Zoom in',
  'Ctrl+-': 'Zoom out',
};

export interface OtherBinding {
  hotkey: string;
  // What this other binding does — surfaces in the warning copy.
  // e.g. "the 'Open BOB' shortcut", "feature 'Hide YouTube Shorts'".
  label: string;
}

export interface ConflictResult {
  // Short red-text message suitable for direct display under an input.
  message: string;
  // Coarse category for callers that want different styling.
  source: 'chrome' | 'extension';
}

// Returns the first conflict found, or null. Empty / falsy hotkeys
// short-circuit to null so an unbound row never shows a warning.
export function findConflict(
  hotkey: string | undefined,
  others: OtherBinding[],
): ConflictResult | null {
  if (!hotkey) return null;

  // Internal conflicts win precedence — they're more actionable
  // (the user controls both bindings).
  for (const o of others) {
    if (o.hotkey && o.hotkey === hotkey) {
      return {
        message: `Already used by ${o.label}.`,
        source: 'extension',
      };
    }
  }

  const chromeAction = CHROME_RESERVED_HOTKEYS[hotkey];
  if (chromeAction) {
    return {
      message: `Chrome already uses this for "${chromeAction}". Pick a different combo or expect both to fire.`,
      source: 'chrome',
    };
  }

  return null;
}
