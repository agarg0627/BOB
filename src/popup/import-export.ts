import type { Feature } from '../shared/types';

interface ExportPayload {
  version: 1;
  exportedAt: number;
  features: Feature[];
}

export async function exportFeatures(): Promise<void> {
  let features: Feature[] = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: 'LIST_FEATURES' });
    if (Array.isArray(res)) features = res;
  } catch {
    throw new Error('Could not load features');
  }

  if (features.length === 0) {
    throw new Error('No features to export');
  }

  const payload: ExportPayload = {
    version: 1,
    exportedAt: Date.now(),
    features,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bob-features-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importFeatures(
  file: File,
  mode: 'merge' | 'replace',
): Promise<{ count: number }> {
  const text = await file.text();
  let payload: ExportPayload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.features)
  ) {
    throw new Error('Invalid BOB export file');
  }

  if (mode === 'replace') {
    try {
      await chrome.runtime.sendMessage({ type: 'BULK_DELETE' });
    } catch {
      throw new Error('Could not clear existing features');
    }
  }

  let count = 0;
  for (const f of payload.features) {
    if (!f.code || !f.name) continue;
    try {
      await chrome.runtime.sendMessage({
        type: 'INSTALL_FEATURE',
        feature: {
          code: f.code,
          name: f.name,
          description: f.description || '',
          urlPattern: f.urlPattern || '*://*/*',
          userPrompt: f.userPrompt || '',
          enabled: f.enabled ?? true,
          runCount: 0,
          errorCount: 0,
        },
      });
      count++;
    } catch {
      // skip individual failures
    }
  }

  return { count };
}
