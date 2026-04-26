// Owned by Person D. Popup UI: feature list + bulk actions + iteration entry
// + suggestions + status surface.
import type { ExtensionSettings, Feature, KeybindSettings, Suggestion } from '../shared/types';
import { applyUiScale } from '../shared/ui-scale';
import { startEdit, maybeReloadActiveTab, patternMatchesUrl } from './iteration';
import { exportSingleFeature } from './import-export';
import { eventToHotkey } from '../shared/hotkey';
import { findConflict, type OtherBinding } from '../shared/keybind-conflicts';

applyUiScale();

const root = document.getElementById('root')!;
const toastEl = document.getElementById('toast') as HTMLDivElement | null;

interface AppState {
  features: Feature[];
  hostname: string | null;
  activeUrl: string | null;
  suggestions: Suggestion[];
  hasApiKey: boolean;
  // Cached settings keybinds, used for conflict detection on per-feature
  // hotkey inputs. null until the first GET_SETTINGS round-trip lands.
  keybinds: KeybindSettings | null;
}

const state: AppState = {
  features: [],
  hostname: null,
  activeUrl: null,
  suggestions: [],
  hasApiKey: true, // assume true until loaded
  keybinds: null,
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ----------------------------------------------------------------------
// Data plumbing
// ----------------------------------------------------------------------

async function getActiveTabInfo(): Promise<{ url: string | null; hostname: string | null }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return { url: null, hostname: null };
    let hostname: string | null = null;
    try {
      const u = new URL(tab.url);
      // Only treat real web pages as having a hostname for filtering.
      // chrome:// and chrome-extension:// (e.g. the Options page itself)
      // would otherwise parse to a meaningless hostname like the extension
      // ID, which then excludes every stored suggestion from the engine's
      // exact-match filter. Returning null falls back to "all hostnames".
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        hostname = u.hostname.replace(/^www\./i, '').toLowerCase() || null;
      }
    } catch {
      hostname = null;
    }
    return { url: tab.url, hostname };
  } catch {
    return { url: null, hostname: null };
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

async function loadSuggestions(hostname: string | null): Promise<Suggestion[]> {
  // Suggestions come from Person C's GET_SUGGESTIONS handler. If that handler
  // isn't wired yet, treat the response as empty and render nothing.
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_SUGGESTIONS',
      hostname: hostname ?? undefined,
    });
    if (Array.isArray(res)) return res as Suggestion[];
    if (res && typeof res === 'object' && Array.isArray((res as { suggestions?: unknown }).suggestions)) {
      return (res as { suggestions: Suggestion[] }).suggestions;
    }
  } catch {
    // No handler yet — empty.
  }
  return [];
}

async function toggleViaBackground(id: string, enabled: boolean): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_FEATURE', id, enabled });
    return !!(res && typeof res === 'object' && (res as { ok?: unknown }).ok);
  } catch {
    return false;
  }
}

async function deleteViaBackground(id: string): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DELETE_FEATURE', id });
    return !!(res && typeof res === 'object' && (res as { ok?: unknown }).ok);
  } catch {
    return false;
  }
}

async function bulkSetEnabled(enabled: boolean): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BULK_TOGGLE', enabled });
    return !!(res && typeof res === 'object' && (res as { ok?: unknown }).ok);
  } catch {
    return false;
  }
}

async function bulkRemoveAll(): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BULK_DELETE' });
    return !!(res && typeof res === 'object' && (res as { ok?: unknown }).ok);
  } catch {
    return false;
  }
}

async function dismissSuggestion(id: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'DISMISS_SUGGESTION', id });
  } catch {
    // No handler — at least update local state so the UI hides it.
  }
  state.suggestions = state.suggestions.filter((s) => s.id !== id);
}

async function acceptSuggestion(
  id: string,
): Promise<{ proposedPrompt: string; hostname: string } | null> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ACCEPT_SUGGESTION', id });
    if (
      res &&
      typeof res === 'object' &&
      typeof (res as { proposedPrompt?: unknown }).proposedPrompt === 'string' &&
      typeof (res as { hostname?: unknown }).hostname === 'string'
    ) {
      return res as { proposedPrompt: string; hostname: string };
    }
  } catch {
    // No handler yet — silent.
  }
  return null;
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

function pencilIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path1.setAttribute('d', 'M12 20h9');
  svg.appendChild(path1);
  const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path2.setAttribute(
    'd',
    'M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  );
  svg.appendChild(path2);
  return svg;
}

function downloadIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path1.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
  svg.appendChild(path1);
  const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path2.setAttribute('points', '7 10 12 15 17 10');
  svg.appendChild(path2);
  const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  path3.setAttribute('x1', '12');
  path3.setAttribute('y1', '15');
  path3.setAttribute('x2', '12');
  path3.setAttribute('y2', '3');
  svg.appendChild(path3);
  return svg;
}

function buildCard(f: Feature): HTMLElement {
  const cardState = cardStateFor(f);
  const card = el('article', {
    className: 'feature-card',
    dataset: { id: f.id, state: cardState },
  });

  const editMatches = !!state.activeUrl && patternMatchesUrl(f.urlPattern, state.activeUrl);

  // ---- info column ----
  const info = el('div', { className: 'card-info' }, [
    el('div', { className: 'feature-name', text: f.name || '(unnamed)', attrs: { title: f.name || '(unnamed)' } }),
    f.description
      ? el('div', { className: 'feature-desc', text: f.description })
      : null,
    buildParentLine(f),
    el('code', { className: 'feature-url', text: f.urlPattern }),
    el('div', { className: 'status-row' }, [
      el('span', { className: 'dot' }),
      el('span', { className: 'status-text', text: statusLabelFor(f) }),
    ]),
    buildHotkeyRow(f),
    buildMetaRow(f),
  ]);

  // ---- actions column ----
  const editBtn = el('button', {
    className: 'icon-btn edit-btn' + (editMatches ? '' : ' edit-btn-disabled'),
    attrs: {
      type: 'button',
      'aria-label': 'Edit feature',
      title: editMatches ? 'Edit on this page' : 'Open a matching page first',
    },
    dataset: { action: 'edit' },
  });
  editBtn.appendChild(pencilIcon());

  const exportBtn = el('button', {
    className: 'icon-btn',
    attrs: {
      type: 'button',
      'aria-label': 'Export feature',
      title: 'Export',
    },
    dataset: { action: 'export-single' },
  });
  exportBtn.appendChild(downloadIcon());

  const actions = el('div', { className: 'card-actions' }, [
    exportBtn,
    editBtn,
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

  card.appendChild(buildCodeDisclosure(f.code));

  return card;
}

function buildParentLine(f: Feature): HTMLElement | null {
  if (!f.parentFeatureId) return null;
  const parent = state.features.find((x) => x.id === f.parentFeatureId);
  const text = parent
    ? `Edited from “${parent.name}”`
    : 'Edited from a previous version';
  return el('div', { className: 'parent-line', text });
}

// Compact per-feature shortcut binder. Lets the user assign a key combo
// that toggles this feature on or off when pressed on a matching page.
//
// UX: the input stays readonly so it can't be edited as text. Click it
// to enter "capture" mode; the next non-modifier press is serialized
// via shared/hotkey.ts and persisted. A short helper line under the
// row explains what the shortcut actually does, to avoid the bare-
// "Hotkey:" mystery.
function buildHotkeyRow(f: Feature): HTMLElement {
  const PLACEHOLDER_IDLE = 'click here, then press a combo';
  const PLACEHOLDER_CAPTURING = 'press a combo…';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hotkey-input';
  input.readOnly = true;
  input.placeholder = PLACEHOLDER_IDLE;
  input.value = f.hotkey ?? '';
  input.title =
    'Press this combo on a matching page to turn this feature on or off.';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'hotkey-clear';
  clearBtn.setAttribute('aria-label', 'Remove shortcut');
  clearBtn.title = 'Remove shortcut';
  clearBtn.textContent = '×';
  if (!f.hotkey) clearBtn.hidden = true;

  const row = el('div', { className: 'hotkey-row' }, [
    el('span', { className: 'hotkey-label', text: 'Toggle shortcut' }),
    input,
    clearBtn,
  ]);

  const help = el('div', {
    className: 'hotkey-help',
    text: 'Optional. Press this combo on a matching page to turn this feature on or off.',
  });

  const warn = el('div', { className: 'hotkey-warn', attrs: { hidden: '' } });
  const block = el('div', { className: 'hotkey-block' }, [row, help, warn]);

  // Compute conflicts against (a) the three Settings keybinds and (b)
  // every other feature's hotkey, then map through findConflict so
  // Chrome reserved combos are also caught.
  const refreshConflict = (): void => {
    const others: OtherBinding[] = [];
    if (state.keybinds) {
      others.push({
        hotkey: state.keybinds.overlay,
        label: 'the "Open BOB" shortcut',
      });
      others.push({
        hotkey: state.keybinds.refineLast,
        label: 'the "Refine last feature" shortcut',
      });
      others.push({
        hotkey: state.keybinds.quickToggle,
        label: 'the "Quick-toggle bar" shortcut',
      });
    }
    for (const other of state.features) {
      if (other.id === f.id) continue;
      if (!other.hotkey) continue;
      others.push({
        hotkey: other.hotkey,
        label: `feature "${other.name || '(unnamed)'}"`,
      });
    }
    const conflict = findConflict(f.hotkey, others);
    if (conflict) {
      warn.textContent = conflict.message;
      warn.removeAttribute('hidden');
      block.classList.add('has-conflict');
    } else {
      warn.textContent = '';
      warn.setAttribute('hidden', '');
      block.classList.remove('has-conflict');
    }
  };

  const persist = async (value: string | undefined): Promise<void> => {
    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_FEATURE',
        id: f.id,
        patch: { hotkey: value },
      });
      // Mutate local state so re-renders reflect immediately without a
      // full reload from background.
      f.hotkey = value;
      input.value = value ?? '';
      clearBtn.hidden = !value;
      refreshConflict();
    } catch {
      showToast('Could not save shortcut');
    }
  };

  input.addEventListener('focus', () => {
    input.classList.add('capturing');
    input.placeholder = PLACEHOLDER_CAPTURING;
  });
  input.addEventListener('blur', () => {
    input.classList.remove('capturing');
    input.placeholder = PLACEHOLDER_IDLE;
  });
  input.addEventListener('keydown', (e) => {
    // Allow Esc to abort capture.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      input.blur();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const hk = eventToHotkey(e);
    if (!hk) return; // modifier-only — keep waiting
    void persist(hk);
    input.blur();
  });

  clearBtn.addEventListener('click', () => {
    void persist(undefined);
  });

  // Initial check so the warning shows on first render if the stored
  // value already conflicts (e.g. another feature shares the combo).
  refreshConflict();

  return block;
}

function buildMetaRow(f: Feature): HTMLElement | null {
  const bits: HTMLElement[] = [];
  if (f.lastRanAt) {
    bits.push(
      el('span', { text: 'Last ran ' + relativeTime(f.lastRanAt) }),
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

function buildCodeDisclosure(code: string): HTMLElement {
  const toggle = el('button', {
    className: 'code-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    dataset: { action: 'toggle-code' },
  }, [
    el('span', { className: 'chev', text: '\u25b8' }),
    document.createTextNode(' View code'),
  ]);

  const block = el('pre', {
    className: 'code-block',
    text: code,
    attrs: { hidden: '' },
  });

  return el('div', { className: 'code-disclosure' }, [toggle, block]);
}

// ----------------------------------------------------------------------
// Suggestions
// ----------------------------------------------------------------------

function buildSuggestionsSection(): HTMLElement | null {
  if (state.suggestions.length === 0) return null;
  const heading = el('h2', { className: 'section-heading', text: 'Suggested for you' });
  const list = el('div', { className: 'suggestion-list' });
  for (const s of state.suggestions) list.appendChild(buildSuggestionCard(s));
  return el('section', { className: 'suggestions-section' }, [heading, list]);
}

function buildSuggestionCard(s: Suggestion): HTMLElement {
  const card = el('article', {
    className: 'suggestion-card',
    dataset: { id: s.id },
  });
  const info = el('div', { className: 'suggestion-info' }, [
    el('div', { className: 'suggestion-prompt', text: s.proposedPrompt }),
    s.rationale ? el('div', { className: 'suggestion-rationale', text: s.rationale }) : null,
  ]);
  const actions = el('div', { className: 'suggestion-actions' }, [
    el('button', {
      className: 'btn-mini btn-mini-primary',
      text: 'Try it',
      attrs: { type: 'button' },
      dataset: { action: 'try-suggestion' },
    }),
    el('button', {
      className: 'btn-mini btn-mini-outline',
      text: 'Later',
      attrs: { type: 'button' },
      dataset: { action: 'later-suggestion' },
    }),
    el('button', {
      className: 'btn-mini btn-mini-muted',
      text: 'Never',
      attrs: { type: 'button' },
      dataset: { action: 'never-suggestion' },
    }),
  ]);
  card.appendChild(info);
  card.appendChild(actions);
  return card;
}

// ----------------------------------------------------------------------
// Top-level rendering
// ----------------------------------------------------------------------

function matchesActiveTab(f: Feature): boolean {
  if (!state.activeUrl) return false;
  return patternMatchesUrl(f.urlPattern, state.activeUrl);
}

function buildStatsRow(activeHere: number, total: number): HTMLElement {
  const row = el('div', { className: 'stats-row' });

  if (state.hostname) {
    const activePill = el('button', {
      className: 'stat-pill',
      attrs: { type: 'button' },
    }, [
      el('span', { className: 'stat-num', text: String(activeHere) }),
      document.createTextNode(' active here'),
    ]);
    activePill.addEventListener('click', () => {
      const section = root.querySelector('.features-section');
      section?.scrollIntoView({ behavior: 'smooth' });
    });
    row.appendChild(activePill);
  }

  const totalPill = el('button', {
    className: 'stat-pill',
    attrs: { type: 'button' },
  }, [
    el('span', { className: 'stat-num', text: String(total) }),
    document.createTextNode(' total'),
  ]);
  totalPill.addEventListener('click', () => {
    const sections = root.querySelectorAll('.features-section');
    const target = sections[sections.length - 1];
    target?.scrollIntoView({ behavior: 'smooth' });
  });
  row.appendChild(totalPill);

  return row;
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

function buildBulkActionsRow(): HTMLElement | null {
  if (state.features.length === 0) return null;
  const allEnabled = state.features.every((f) => f.enabled);
  const allDisabled = state.features.every((f) => !f.enabled);
  return el('div', { className: 'bulk-actions' }, [
    el('button', {
      className: 'bulk-btn',
      text: 'All on',
      attrs: { type: 'button', ...(allEnabled ? { disabled: '' } : {}) },
      dataset: { action: 'bulk-enable' },
    }),
    el('button', {
      className: 'bulk-btn',
      text: 'All off',
      attrs: { type: 'button', ...(allDisabled ? { disabled: '' } : {}) },
      dataset: { action: 'bulk-disable' },
    }),
    el('button', {
      className: 'bulk-btn bulk-btn-danger',
      text: 'Delete all',
      attrs: { type: 'button' },
      dataset: { action: 'bulk-delete' },
    }),
  ]);
}

function render(): void {
  root.replaceChildren();

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

  if (state.features.length > 0) {
    const activeHere = state.activeUrl
      ? state.features.filter((f) => matchesActiveTab(f) && f.enabled && !f.lastError).length
      : 0;
    root.appendChild(buildStatsRow(activeHere, state.features.length));
  }

  const body = el('div', { className: 'popup-body' });

  if (state.features.length === 0 && state.suggestions.length === 0) {
    if (!state.hasApiKey) {
      body.appendChild(buildWelcome());
    }
    body.appendChild(buildEmptyState());
  } else {
    const bulk = buildBulkActionsRow();
    if (bulk) body.appendChild(bulk);

    let thisSite: Feature[] = [];
    let other: Feature[] = state.features;
    if (state.activeUrl && state.hostname) {
      thisSite = state.features.filter((f) => matchesActiveTab(f));
      const thisIds = new Set(thisSite.map((f) => f.id));
      other = state.features.filter((f) => !thisIds.has(f.id));
    }
    const s1 = buildSection('Features for this site', state.hostname, thisSite);
    if (s1) body.appendChild(s1);

    const sug = buildSuggestionsSection();
    if (sug) body.appendChild(sug);

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
  hint.appendChild(el('kbd', { text: '\u2318K' }));
  hint.appendChild(document.createTextNode(' on any webpage to make your first one.'));
  wrap.appendChild(hint);
  return wrap;
}

function buildWelcome(): HTMLElement {
  const wrap = el('div', { className: 'welcome' });
  wrap.appendChild(el('p', { className: 'welcome-title', text: 'Welcome to BOB.' }));
  wrap.appendChild(
    el('p', {
      className: 'welcome-body',
      text: 'BOB lets you customize any webpage with natural language. To get started, add an API key from Anthropic, OpenAI, or Google.',
    }),
  );
  const btn = el('button', {
    className: 'welcome-btn',
    text: 'Open Settings',
    attrs: { type: 'button' },
    dataset: { action: 'open-options' },
  });
  wrap.appendChild(btn);
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
  const target = !f.enabled;
  const ok = await toggleViaBackground(id, target);
  if (!ok) {
    showToast('Toggle failed');
    return;
  }
  await refreshFromBackend();
  render();

  // Reload the active tab when our toggle would actually change what's
  // rendered there. For ON: re-running picks up the new feature. For OFF:
  // a reload clears any installed effects.
  const fresh = findFeature(id) ?? f;
  const result = await maybeReloadActiveTab(fresh);
  if (result.reloaded) {
    showToast('Reloading page…');
  } else if (result.matched) {
    showToast('Tab matched but reload failed');
  } else {
    showToast('Toggle takes effect on next page load');
  }
}

async function remove(id: string): Promise<void> {
  const f = findFeature(id);
  if (!f) return;
  if (!confirm(`Delete "${f.name}"?`)) return;
  const wasEnabledMatch = f.enabled;
  const snapshot = { ...f };
  const ok = await deleteViaBackground(id);
  if (!ok) {
    showToast('Delete failed');
    return;
  }
  await refreshFromBackend();
  render();
  if (wasEnabledMatch) {
    const result = await maybeReloadActiveTab(snapshot);
    if (result.reloaded) showToast('Deleted · Reloading page…');
    else showToast('Deleted');
  } else {
    showToast('Deleted');
  }
}

async function handleEdit(id: string): Promise<void> {
  const f = findFeature(id);
  if (!f) return;
  const result = await startEdit(f);
  if (result.ok) {
    // The popup must close so the overlay can take focus on the page.
    window.close();
    return;
  }
  if (result.reason === 'mismatch') {
    showToast('Open a matching page first');
  } else if (result.reason === 'no-tab') {
    showToast('No active tab');
  } else {
    showToast('Could not open editor');
  }
}

async function reloadActiveTab(): Promise<void> {
  // Bulk actions change which features run on the active tab, so reload it
  // to apply the new state immediately. Best-effort — silent if unavailable.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.reload(tab.id);
  } catch {
    /* ignore */
  }
}

async function bulkEnable(): Promise<void> {
  const ok = await bulkSetEnabled(true);
  if (!ok) {
    showToast('Bulk enable failed');
    return;
  }
  await refreshFromBackend();
  render();
  showToast('Enabled all features');
  await reloadActiveTab();
}

async function bulkDisable(): Promise<void> {
  if (state.features.length === 0) return;
  if (!confirm('Disable all features?')) return;
  const ok = await bulkSetEnabled(false);
  if (!ok) {
    showToast('Bulk disable failed');
    return;
  }
  await refreshFromBackend();
  render();
  showToast('Disabled all features');
  await reloadActiveTab();
}

async function bulkDelete(): Promise<void> {
  if (state.features.length === 0) return;
  if (!confirm(`Delete all ${state.features.length} features? This cannot be undone.`)) return;
  const ok = await bulkRemoveAll();
  if (!ok) {
    showToast('Bulk delete failed');
    return;
  }
  await refreshFromBackend();
  render();
  showToast('Deleted all features');
  await reloadActiveTab();
}

async function refreshFromBackend(): Promise<void> {
  state.features = await loadFeatures();
}

async function trySuggestion(id: string): Promise<void> {
  const accepted = await acceptSuggestion(id);
  if (!accepted) {
    showToast('Could not accept suggestion');
    return;
  }
  // Try to open the overlay on the active tab if it matches the hostname.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url) {
      let host: string | null = null;
      try {
        const u = new URL(tab.url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          host = u.hostname.replace(/^www\./i, '').toLowerCase();
        }
      } catch {
        host = null;
      }
      if (host === accepted.hostname) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'OPEN_OVERLAY_WITH_PROMPT',
            prompt: accepted.proposedPrompt,
          });
        } catch {
          // Content script may not be loaded; fall through.
        }
      }
    }
  } catch {
    // ignore
  }
  window.close();
}

async function dismissSuggestionAction(id: string): Promise<void> {
  await dismissSuggestion(id);
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

function toggleCodeBlock(card: HTMLElement): void {
  const toggle = card.querySelector<HTMLButtonElement>(
    'button[data-action="toggle-code"]',
  );
  const block = card.querySelector<HTMLElement>('.code-block');
  if (!toggle || !block) return;
  const open = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
  if (open) {
    block.setAttribute('hidden', '');
    const chev = toggle.querySelector('.chev');
    if (chev) chev.textContent = '\u25b8';
    toggle.childNodes[1].textContent = ' View code';
  } else {
    block.removeAttribute('hidden');
    const chev = toggle.querySelector('.chev');
    if (chev) chev.textContent = '\u25be';
    toggle.childNodes[1].textContent = ' Hide code';
  }
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

async function handleExportSingle(id: string): Promise<void> {
  try {
    await exportSingleFeature(id);
    showToast('Exported');
  } catch (e) {
    showToast((e as Error).message || 'Export failed');
  }
}

async function laterSuggestion(id: string): Promise<void> {
  await dismissSuggestion(id);
  render();
  showToast('Snoozed');
}

async function neverSuggestion(id: string): Promise<void> {
  if (!confirm('Permanently hide this suggestion?')) return;
  await dismissSuggestion(id);
  render();
  showToast('Dismissed permanently');
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
  if (btn.disabled) return;
  const action = btn.dataset.action;

  // Top-level actions (no card scope).
  switch (action) {
    case 'open-options':
      openOptions();
      return;
    case 'bulk-enable':
      void bulkEnable();
      return;
    case 'bulk-disable':
      void bulkDisable();
      return;
    case 'bulk-delete':
      void bulkDelete();
      return;
  }

  // Suggestion-scoped actions.
  const sCard = btn.closest('.suggestion-card') as HTMLElement | null;
  if (sCard) {
    const sId = sCard.dataset.id;
    if (!sId) return;
    if (action === 'try-suggestion') void trySuggestion(sId);
    else if (action === 'dismiss-suggestion') void dismissSuggestionAction(sId);
    else if (action === 'later-suggestion') void laterSuggestion(sId);
    else if (action === 'never-suggestion') void neverSuggestion(sId);
    return;
  }

  // Feature-scoped actions.
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
    case 'edit':
      void handleEdit(id);
      break;
    case 'toggle-error':
      toggleErrorDetail(card);
      break;
    case 'toggle-code':
      toggleCodeBlock(card);
      break;
    case 'copy-error':
      void copyError(id);
      break;
    case 'export-single':
      void handleExportSingle(id);
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

async function loadHasApiKey(): Promise<boolean> {
  try {
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings as { apiKeys?: Record<string, string> } | undefined;
    if (!settings?.apiKeys) return false;
    return Object.values(settings.apiKeys).some((v) => !!v);
  } catch {
    return false;
  }
}

async function loadKeybinds(): Promise<KeybindSettings | null> {
  try {
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (settings && typeof settings === 'object' && 'keybinds' in settings) {
      const k = (settings as ExtensionSettings).keybinds;
      if (k) {
        return {
          overlay: k.overlay ?? 'Ctrl+K',
          refineLast: k.refineLast ?? 'Ctrl+I',
          quickToggle: k.quickToggle ?? 'Ctrl+Shift+Y',
        };
      }
    }
  } catch {
    // background not ready
  }
  return null;
}

async function boot(): Promise<void> {
  showLoading();
  const tabInfo = await getActiveTabInfo();
  state.activeUrl = tabInfo.url;
  state.hostname = tabInfo.hostname;
  // Features, suggestions, settings + keybinds in parallel.
  const [features, suggestions, hasApiKey, keybinds] = await Promise.all([
    loadFeatures(),
    loadSuggestions(tabInfo.hostname),
    loadHasApiKey(),
    loadKeybinds(),
  ]);
  state.features = features;
  state.suggestions = suggestions;
  state.hasApiKey = hasApiKey;
  state.keybinds = keybinds;
  render();
}

void boot();
