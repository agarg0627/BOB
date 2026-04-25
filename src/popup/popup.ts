// Owned by Person D. Phase 1: popup feature list.
import type { Feature } from '../shared/types';

const root = document.getElementById('root')!;

async function loadFeatures(): Promise<Feature[]> {
  // Try the message-based API first (wired up at integration time)
  try {
    const features = await chrome.runtime.sendMessage({ type: 'LIST_FEATURES' });
    if (Array.isArray(features)) return features;
  } catch {
    // Handler not registered yet — fall through
  }

  // Fallback: read storage directly
  try {
    const data = await chrome.storage.local.get('features');
    if (Array.isArray(data.features)) return data.features;
  } catch {
    // Storage unavailable (e.g. running outside extension context)
  }

  return [];
}

function renderEmpty(): void {
  root.innerHTML = `
    <header class="header">
      <h1>BOB</h1>
      <p class="subtitle">Your installed features</p>
    </header>
    <div class="empty-state">
      <p>No features yet.</p>
      <p>Press <kbd>\u2318K</kbd> on any page to create one.</p>
    </div>
  `;
}

function renderFeatures(features: Feature[]): void {
  root.innerHTML = `
    <header class="header">
      <h1>BOB</h1>
      <p class="subtitle">${features.length} feature${features.length === 1 ? '' : 's'} installed</p>
    </header>
    <div id="feature-list"></div>
  `;

  const list = document.getElementById('feature-list')!;

  for (const f of features) {
    const card = document.createElement('div');
    card.className = 'feature-card';
    card.innerHTML = `
      <div class="feature-info">
        <span class="feature-name">${escapeHtml(f.name)}</span>
        <span class="feature-desc">${escapeHtml(f.description)}</span>
        <span class="feature-url">${escapeHtml(f.urlPattern)}</span>
      </div>
      <div class="feature-actions">
        <button class="toggle ${f.enabled ? 'on' : ''}" data-id="${f.id}" title="${f.enabled ? 'Disable' : 'Enable'}">
          <span class="toggle-knob"></span>
        </button>
        <button class="delete" data-id="${f.id}" title="Delete">\u00d7</button>
      </div>
    `;
    list.appendChild(card);
  }

  list.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('button');
    if (!btn) return;

    const id = btn.dataset.id!;

    if (btn.classList.contains('toggle')) {
      await toggleFeature(id, features);
    } else if (btn.classList.contains('delete')) {
      await deleteFeature(id, features);
    }
  });
}

async function toggleFeature(id: string, features: Feature[]): Promise<void> {
  const feature = features.find((f) => f.id === id);
  if (!feature) return;

  feature.enabled = !feature.enabled;

  try {
    await chrome.storage.local.set({ features });
  } catch {
    // Outside extension context
  }

  render(features);
}

async function deleteFeature(id: string, features: Feature[]): Promise<void> {
  if (!confirm('Delete this feature?')) return;

  const updated = features.filter((f) => f.id !== id);

  try {
    await chrome.storage.local.set({ features: updated });
  } catch {
    // Outside extension context
  }

  render(updated);
}

function render(features: Feature[]): void {
  if (features.length === 0) {
    renderEmpty();
  } else {
    renderFeatures(features);
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Boot
loadFeatures().then(render);
