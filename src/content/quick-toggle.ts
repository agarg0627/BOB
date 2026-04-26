// Quick-toggle bar: a compact panel that lists features matching the
// current URL and lets the user flip them on/off without opening the
// extension popup. Triggered by Cmd+Shift+Y (Ctrl+Shift+Y on Windows).
//
// Lives entirely in a shadow DOM anchored bottom-right of the viewport
// so it can't be styled or stolen by host CSS. Uses chrome.runtime for
// data; toggles trigger location.reload() after a short delay so the
// flipped feature actually takes effect on the page the user is looking
// at.

import type { Feature, KeybindSettings } from '../shared/types';
import { eventToHotkey } from '../shared/hotkey';

// Configured keybinds. Defaults match background/settings.ts so the
// listener works even before settings are loaded.
const DEFAULT_KEYBINDS: KeybindSettings = {
  overlay: 'Ctrl+K',
  refineLast: 'Ctrl+I',
  quickToggle: 'Ctrl+Shift+Y',
};
let cachedKeybinds: KeybindSettings = { ...DEFAULT_KEYBINDS };

export function setQuickToggleKeybinds(next: Partial<KeybindSettings>): void {
  cachedKeybinds = {
    overlay: next.overlay || DEFAULT_KEYBINDS.overlay,
    refineLast: next.refineLast || DEFAULT_KEYBINDS.refineLast,
    quickToggle: next.quickToggle || DEFAULT_KEYBINDS.quickToggle,
  };
}

const HOST_TAG = 'bob-toggle-host';
const RELOAD_DELAY_MS = 200;

const css = `
:host {
  all: initial;
  position: fixed;
  inset: auto 0 0 auto;
  z-index: 2147483646;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.panel {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 280px;
  max-height: 60vh;
  overflow-y: auto;
  background: rgba(20, 20, 22, 0.96);
  color: #f5f5f5;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  padding: 10px 0;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 160ms ease, transform 160ms ease;
  pointer-events: auto;
}
.panel.visible {
  opacity: 1;
  transform: translateY(0);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 14px 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
}
.kbd {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.7);
}
.list { display: flex; flex-direction: column; }
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  border-radius: 6px;
}
.row:hover { background: rgba(255, 255, 255, 0.04); }
.dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  flex-shrink: 0;
}
.row[data-state="on"] .dot { background: #4ade80; }
.row[data-state="error"] .dot { background: #f87171; }
.name {
  flex: 1;
  font-size: 13px;
  color: #f5f5f5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row[data-state="off"] .name { color: rgba(255, 255, 255, 0.4); }
.toggle {
  width: 28px; height: 16px;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  border-radius: 999px;
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: background 120ms;
}
.row[data-state="on"] .toggle { background: #4ade80; }
.knob {
  position: absolute;
  top: 2px; left: 2px;
  width: 12px; height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform 120ms;
}
.row[data-state="on"] .knob { transform: translateX(12px); }
.empty {
  padding: 14px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  text-align: center;
}
`;

let host: HTMLElement | null = null;
let panel: HTMLDivElement | null = null;
let active = false;
let busy = false;

function buildHost(): HTMLElement {
  const h = document.createElement(HOST_TAG);
  const root = h.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  const p = document.createElement('div');
  p.className = 'panel';
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'BOB feature toggle bar');

  root.appendChild(p);
  panel = p;
  return h;
}

function close(): void {
  if (!host || !panel) return;
  panel.classList.remove('visible');
  // Defer host removal so the fade-out animation can play.
  const h = host;
  setTimeout(() => {
    if (h.parentNode) h.parentNode.removeChild(h);
  }, 200);
  host = null;
  panel = null;
  active = false;
}

function rowState(f: Feature): 'on' | 'off' | 'error' {
  if (!f.enabled) return 'off';
  if (f.lastError) return 'error';
  return 'on';
}

function buildRow(f: Feature, onClick: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.state = rowState(f);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `${f.enabled ? 'Disable' : 'Enable'} ${f.name}`);

  const dot = document.createElement('span');
  dot.className = 'dot';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = f.name || '(unnamed)';

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-hidden', 'true');
  toggle.tabIndex = -1;
  const knob = document.createElement('span');
  knob.className = 'knob';
  toggle.appendChild(knob);

  row.appendChild(dot);
  row.appendChild(name);
  row.appendChild(toggle);

  row.addEventListener('click', onClick);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });

  return row;
}

async function loadFeatures(): Promise<Feature[]> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_FEATURES_FOR_URL',
      url: location.href,
    });
    return Array.isArray(res) ? (res as Feature[]) : [];
  } catch {
    return [];
  }
}

async function open(): Promise<void> {
  if (active) return;
  active = true;

  host = buildHost();
  document.body.appendChild(host);
  // Force a layout pass so the fade-in transitions from 0 → 1.
  void host.offsetWidth;
  panel?.classList.add('visible');

  const features = await loadFeatures();
  if (!panel) return; // Closed mid-load.

  panel.replaceChildren();

  const header = document.createElement('div');
  header.className = 'header';
  const title = document.createElement('span');
  title.textContent = 'Features here';
  const kbd = document.createElement('span');
  kbd.className = 'kbd';
  kbd.textContent = 'Esc';
  header.appendChild(title);
  header.appendChild(kbd);
  panel.appendChild(header);

  if (features.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No features for this site yet.';
    panel.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'list';
  for (const f of features) {
    list.appendChild(buildRow(f, () => void onToggle(f)));
  }
  panel.appendChild(list);
}

async function onToggle(f: Feature): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await chrome.runtime.sendMessage({
      type: 'TOGGLE_FEATURE',
      id: f.id,
      enabled: !f.enabled,
    });
  } catch {
    busy = false;
    return;
  }
  // Visual hint: dim the panel during reload so the user knows the click
  // registered. Then reload to apply the new state.
  if (panel) panel.style.opacity = '0.4';
  setTimeout(() => location.reload(), RELOAD_DELAY_MS);
}

export function initQuickToggle(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      const hk = eventToHotkey(e);
      if (!hk) return;
      if (hk !== cachedKeybinds.quickToggle) return;
      e.preventDefault();
      e.stopPropagation();
      if (active) close();
      else void open();
    },
    true,
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (!active) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );
}
