// Canonical hotkey serialization. Both popup (capture mode) and content
// script (matching) must produce identical strings for a given combo,
// so this is the single source of truth.
//
// Format: "Ctrl+Shift+Alt+<KEY>" — modifiers in fixed order, single
// printable keys upper-cased, named keys (Arrow*, Enter, Escape, F1..)
// kept verbatim. Cmd is normalized to "Ctrl" so cross-platform feature
// records are portable.

export function isModifierKey(e: KeyboardEvent): boolean {
  return e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta';
}

export function eventToHotkey(e: KeyboardEvent): string | null {
  if (isModifierKey(e)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(k);

  return parts.join('+');
}
