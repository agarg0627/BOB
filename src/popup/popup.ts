// Owned by Person D. Popup UI: feature list + status surface.
import type { Feature } from '../shared/types';

const root = document.getElementById('root')!;
const toastEl = document.getElementById('toast') as HTMLDivElement | null;

interface AppState {
  features: Feature[];
  hostname: string | null;
}

const state: AppState = {
  features: [],
  hostname: null,
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ----------------------------------------------------------------------
// Data plumbing
// ----------------------------------------------------------------------

async function getActiveHostname(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.url) return null;
    const url = new URL(tab.url);
    return url.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

async function loadFeatures(): Promise<Feature[]> {
  try {
    const features = await chrome.runtime.sendMessage({ type: 'LIST_FEATURES' });
    if (Array.isArray(features)) return features;
  } catch {
    // Background handler not registered yet — fall through.
  }
  try {
    const data = await chrome.storage.local.get('features');
    if (Array.isArray(data.features)) return data.features as Feature[];
  } catch {
    // Outside extension context.
  }
  return [];
}

async function saveFeatures(features: Feature[]): Promise<void> {
  try {
    await chrome.storage.local.set({ features });
  } catch {
    // Outside extension context — best effort.
  }
}

// ----------------------------------------------------------------------
// Status / formatting
// ----------------------------------------------------------------------

type CardState = 'disabled' | 'error' | 'working' | 'never';

function cardStateFor(f: Feature): CardState {
  if (!f.enabled) return 'disabled';
  if (f.lastError) return 'error';
  if ((f.runCount ?? 0) > 0) return 'working';
  return 'never';
}

function statusLabelFor(f: Feature): string {
  switch (cardStateFor(f)) {
    case 'disabled':
      return 'Disabled';
    case 'error':
      return 'Last error: ' + truncate(f.lastError ?? '', 40);
    case 'working':
      return 'Working';
    case 'never':
      return 'Not run yet';
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  if (day < 14) return 'last week';
  if (day < 30) return `${Math.floor(day / 7)} weeks ago`;
  const date = new Date(ts);
  const nowDate = new Date(now);
  const sameYear = date.getFullYear() === nowDate.getFullYear();
  return new Intl.DateTimeFormat('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' },
  ).format(date);
}

// ----------------------------------------------------------------------
// DOM building (createElement-based to keep things XSS-safe by default)
// ----------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<{
    className: string;
    text: string;
    attrs: Record<string, string>;
    dataset: Record<string, string>;
  }> = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text != null) node.textContent = props.text;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  }
  if (props.dataset) {
    for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '3');
  svg.appendChild(circle);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  );
  svg.appendChild(path);
  return svg;
}

function buildCard(f: Feature): HTMLElement {
  const cardState = cardStateFor(f);
  const card = el('article', {
    className: 'feature-card',
    dataset: { id: f.id, state: cardState },
  });

  // ---- info column ----
  const info = el('div', { className: 'card-info' }, [
    el('div', { className: 'feature-name', text: f.name || '(unnamed)' }),
    f.description
      ? el('div', { className: 'feature-desc', text: f.description })
      : null,
    el('code', { className: 'feature-url', text: f.urlPattern }),
    el('div', { className: 'status-row' }, [
      el('span', { className: 'dot' }),
      el('span', { className: 'status-text', text: statusLabelFor(f) }),
    ]),
    buildMetaRow(f),
  ]);

  // ---- actions column ----
  const actions = el('div', { className: 'card-actions' }, [
    (() => {
      const t = el('button', {
        className: 'toggle' + (f.enabled ? ' on' : ''),
        attrs: {
          type: 'button',
          role: 'switch',
          'aria-checked': f.enabled ? 'true' : 'false',
          title: f.enabled ? 'Disable' : 'Enable',
        },
        dataset: { action: 'toggle' },
      });
      t.appendChild(el('span', { className: 'toggle-knob' }));
      return t;
    })(),
    el('button', {
      className: 'delete',
      text: '×',
      attrs: { type: 'button', 'aria-label': 'Delete feature', title: 'Delete' },
      dataset: { action: 'delete' },
    }),
  ]);

  card.appendChild(el('div', { className: 'card-row' }, [info, actions]));

  if (f.lastError) {
    card.appendChild(buildErrorBlock(f.lastError));
  }

  return card;
}

function buildMetaRow(f: Feature): HTMLElement | null {
  const bits: HTMLElement[] = [];
  if (f.lastRanAt) {
    bits.push(
      el('span', {
        text: 'Last ran ' + relativeTime(f.lastRanAt),
      }),
    );
  }
  if ((f.runCount ?? 0) > 0) {
    if (bits.length > 0) bits.push(el('span', { text: '·' }));
    const errs = f.errorCount ?? 0;
    bits.push(
      el('span', {
        text: `${f.runCount} run${f.runCount === 1 ? '' : 's'}, ${errs} error${
          errs === 1 ? '' : 's'
        }`,
      }),
    );
  }
  if (bits.length === 0) return null;
  return el('div', { className: 'meta-row' }, bits);
}

function buildErrorBlock(errorText: string): HTMLElement {
  const expander = el('button', {
    className: 'expander',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    dataset: { action: 'toggle-error' },
  }, [
    document.createTextNode('View error '),
    el('span', { className: 'chev', text: '▾' }),
  ]);

  const detail = el('div', {
    className: 'error-detail',
    attrs: { hidden: '' },
  }, [
    el('pre', { className: 'error-text', text: errorText }),
    el('button', {
      className: 'copy-btn',
      text: 'Copy',
      attrs: { type: 'button' },
      dataset: { action: 'copy-error' },
    }),
  ]);

  return el('div', { className: 'error-block' }, [expander, detail]);
}

// ----------------------------------------------------------------------
// Top-level rendering
// ----------------------------------------------------------------------

function matchesHost(f: Feature, host: string): boolean {
  if (!host) return false;
  return f.urlPattern.toLowerCase().includes(host.toLowerCase());
}

function buildSection(
  title: string,
  hostnameLabel: string | null,
  features: Feature[],
): HTMLElement | null {
  if (features.length === 0) return null;
  const heading = el('h2', { className: 'section-heading' });
  heading.appendChild(document.createTextNode(title));
  if (hostnameLabel) {
    heading.appendChild(
      el('span', { className: 'hostname', text: hostnameLabel }),
    );
  }
  const list = el('div', { className: 'feature-list' });
  for (const f of features) list.appendChild(buildCard(f));
  return el('section', { className: 'features-section' }, [heading, list]);
}

function render(): void {
  root.replaceChildren();

  // Header (always present).
  const header = el('header', { className: 'popup-header' }, [
    el('h1', { text: 'BOB' }),
    (() => {
      const btn = el('button', {
        className: 'settings-btn',
        attrs: { type: 'button', 'aria-label': 'Open settings', title: 'Settings' },
        dataset: { action: 'open-options' },
      });
      btn.appendChild(gearIcon());
      return btn;
    })(),
  ]);
  root.appendChild(header);

  // Body.
  const body = el('div', { className: 'popup-body' });

  if (state.features.length === 0) {
    body.appendChild(buildEmptyState());
  } else {
    let thisSite: Feature[] = [];
    let other: Feature[] = state.features;
    if (state.hostname) {
      thisSite = state.features.filter((f) => matchesHost(f, state.hostname!));
      const thisIds = new Set(thisSite.map((f) => f.id));
      other = state.features.filter((f) => !thisIds.has(f.id));
    }
    const s1 = buildSection('Features for this site', state.hostname, thisSite);
    if (s1) body.appendChild(s1);
    const s2 = buildSection('All features', null, other);
    if (s2) body.appendChild(s2);
  }

  root.appendChild(body);
}

function buildEmptyState(): HTMLElement {
  const wrap = el('div', { className: 'empty-state' });
  wrap.appendChild(el('p', { text: 'No features yet.' }));
  const hint = el('p');
  hint.appendChild(document.createTextNode('Press '));
  hint.appendChild(el('kbd', { text: '⌘K' }));
  hint.appendChild(document.createTextNode(' on any page to create one.'));
  wrap.appendChild(hint);
  return wrap;
}

// ----------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------

function findFeature(id: string): Feature | undefined {
  return state.features.find((f) => f.id === id);
}

async function toggle(id: string): Promise<void> {
  const f = findFeature(id);
  if (!f) return;
  f.enabled = !f.enabled;
  await saveFeatures(state.features);
  render();
}

async function remove(id: string): Promise<void> {
  const f = findFeature(id);
  if (!f) return;
  if (!confirm(`Delete "${f.name}"?`)) return;
  state.features = state.features.filter((x) => x.id !== id);
  await saveFeatures(state.features);
  render();
}

function toggleErrorDetail(card: HTMLElement): void {
  const expander = card.querySelector<HTMLButtonElement>(
    'button[data-action="toggle-error"]',
  );
  const detail = card.querySelector<HTMLElement>('.error-detail');
  if (!expander || !detail) return;
  const open = expander.getAttribute('aria-expanded') === 'true';
  expander.setAttribute('aria-expanded', open ? 'false' : 'true');
  if (open) detail.setAttribute('hidden', '');
  else detail.removeAttribute('hidden');
}

async function copyError(id: string): Promise<void> {
  const f = findFeature(id);
  if (!f?.lastError) return;
  try {
    await navigator.clipboard.writeText(f.lastError);
    showToast('Copied to clipboard');
  } catch {
    showToast('Copy failed');
  }
}

function openOptions(): void {
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    showToast('Options page unavailable');
  }
}

function showToast(text: string): void {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.removeAttribute('hidden');
  // Force a reflow so the transition kicks in even when class is toggled
  // immediately after un-hiding.
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => {
      if (!toastEl.classList.contains('show')) toastEl.setAttribute('hidden', '');
    }, 200);
  }, 1400);
}

// ----------------------------------------------------------------------
// Event delegation
// ----------------------------------------------------------------------

root.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest('button[data-action]') as HTMLButtonElement | null;
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'open-options') {
    openOptions();
    return;
  }
  const card = btn.closest('.feature-card') as HTMLElement | null;
  const id = card?.dataset.id;
  if (!card || !id) return;
  switch (action) {
    case 'toggle':
      void toggle(id);
      break;
    case 'delete':
      void remove(id);
      break;
    case 'toggle-error':
      toggleErrorDetail(card);
      break;
    case 'copy-error':
      void copyError(id);
      break;
  }
});

// ----------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------

function showLoading(): void {
  root.replaceChildren(
    el('header', { className: 'popup-header' }, [
      el('h1', { text: 'BOB' }),
    ]),
    el('div', { className: 'loading', text: 'Loading…' }),
  );
}

async function boot(): Promise<void> {
  showLoading();
  const [features, hostname] = await Promise.all([
    loadFeatures(),
    getActiveHostname(),
  ]);
  state.features = features;
  state.hostname = hostname;
  render();
}

void boot();
