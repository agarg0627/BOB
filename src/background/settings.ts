import type { ExtensionSettings } from '../shared/types';

const KEY = 'settings';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: 'anthropic',
  apiKeys: {},
};

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(KEY);
  const stored = (raw[KEY] || {}) as Partial<ExtensionSettings>;
  return {
    provider: stored.provider ?? DEFAULT_SETTINGS.provider,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys ?? {}) },
    model: stored.model,
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
  };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
