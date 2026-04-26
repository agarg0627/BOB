import type { ExtensionSettings, KeybindSettings } from '../shared/types';

const KEY = 'settings';

export const DEFAULT_KEYBINDS: KeybindSettings = {
  overlay: 'Ctrl+K',
  refineLast: 'Ctrl+I',
  quickToggle: 'Ctrl+Shift+Y',
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: 'anthropic',
  apiKeys: {},
  effortMode: 'standard',
  keybinds: { ...DEFAULT_KEYBINDS },
};

// Resolve user-configured keybinds against the defaults, returning a
// fully-populated KeybindSettings (no optional fields). Used by content
// scripts that need to compare a pressed combo without worrying about
// undefined holes in the stored partial.
export function resolveKeybinds(
  partial: Partial<KeybindSettings> | undefined,
): KeybindSettings {
  return {
    overlay: partial?.overlay || DEFAULT_KEYBINDS.overlay,
    refineLast: partial?.refineLast || DEFAULT_KEYBINDS.refineLast,
    quickToggle: partial?.quickToggle || DEFAULT_KEYBINDS.quickToggle,
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(KEY);
  const stored = (raw[KEY] || {}) as Partial<ExtensionSettings>;
  return {
    provider: stored.provider ?? DEFAULT_SETTINGS.provider,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys ?? {}) },
    model: stored.model,
    effortMode: stored.effortMode ?? DEFAULT_SETTINGS.effortMode,
    keybinds: resolveKeybinds(stored.keybinds),
  };
}

export async function setSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = {
    provider: patch.provider ?? current.provider,
    apiKeys: { ...current.apiKeys, ...(patch.apiKeys ?? {}) },
    model: 'model' in patch ? patch.model : current.model,
    // Mirror the `'model' in patch` pattern so callers can explicitly
    // clear effortMode back to the default by passing `undefined`.
    effortMode: 'effortMode' in patch ? patch.effortMode : current.effortMode,
    // Keybind patches merge field-by-field so the caller can update one
    // shortcut without resending all three. Empty/undefined values fall
    // back to defaults in resolveKeybinds().
    keybinds: resolveKeybinds({
      ...current.keybinds,
      ...(patch.keybinds ?? {}),
    }),
  };
  for (const key of Object.keys(next.apiKeys) as Array<keyof typeof next.apiKeys>) {
    if (!next.apiKeys[key]) delete next.apiKeys[key];
  }
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
