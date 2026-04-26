import type { ExtensionSettings, KeybindSettings, LLMProvider } from '../shared/types';
import { applyUiScale } from '../shared/ui-scale';
import { DEFAULT_KEYBINDS, getSettings, setSettings } from '../background/settings';
import { anthropicProvider } from '../background/providers/anthropic';
import { openaiProvider } from '../background/providers/openai';
import { googleProvider } from '../background/providers/google';
import { exportFeatures, importFeatures } from '../popup/import-export';
import { eventToHotkey } from '../shared/hotkey';
import { findConflict } from '../shared/keybind-conflicts';

applyUiScale();

const PROVIDER_DEFAULTS: Record<LLMProvider, string> = {
  anthropic: anthropicProvider.defaultModel,
  openai: openaiProvider.defaultModel,
  google: googleProvider.defaultModel,
};

const KEY_VALIDATORS: Record<LLMProvider, (key: string) => string | null> = {
  anthropic: (k) =>
    k.startsWith('sk-ant-')
      ? null
      : "This doesn't look like a valid Anthropic key (expected sk-ant-\u2026). It might still work \u2014 providers occasionally change formats.",
  openai: (k) =>
    k.startsWith('sk-')
      ? null
      : "This doesn't look like a valid OpenAI key (expected sk-\u2026). It might still work \u2014 providers occasionally change formats.",
  google: (k) =>
    /^[A-Za-z0-9_-]{30,}$/.test(k)
      ? null
      : "This doesn't look like a valid Google AI key (~39 alphanumeric chars expected). It might still work \u2014 providers occasionally change formats.",
};

const form = document.getElementById('settings-form') as HTMLFormElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

const keyInputs: Record<LLMProvider, HTMLInputElement> = {
  anthropic: document.getElementById('key-anthropic') as HTMLInputElement,
  openai: document.getElementById('key-openai') as HTMLInputElement,
  google: document.getElementById('key-google') as HTMLInputElement,
};

const warnEls: Record<LLMProvider, HTMLParagraphElement> = {
  anthropic: document.getElementById('warn-anthropic') as HTMLParagraphElement,
  openai: document.getElementById('warn-openai') as HTMLParagraphElement,
  google: document.getElementById('warn-google') as HTMLParagraphElement,
};

const noKeyBanner = document.getElementById('no-key-banner') as HTMLDivElement | null;
const noKeyHelpToggle = document.getElementById('no-key-help-toggle') as HTMLButtonElement | null;
const noKeyLinks = document.getElementById('no-key-links') as HTMLDivElement | null;

let statusTimer: number | undefined;

function selectedProvider(): LLMProvider {
  const checked = form.querySelector<HTMLInputElement>('input[name="provider"]:checked');
  return (checked?.value as LLMProvider) || 'anthropic';
}

const MODEL_PLACEHOLDERS: Record<LLMProvider, string> = {
  anthropic: PROVIDER_DEFAULTS.anthropic,
  openai: PROVIDER_DEFAULTS.openai,
  google: 'gemini-3.1-pro-preview · gemma-4-31b-it · gemma-4-26b-a4b-it',
};

const modelHintEl = document.getElementById('model-hint') as HTMLParagraphElement | null;

function updateModelPlaceholder(): void {
  const provider = selectedProvider();
  modelInput.placeholder = MODEL_PLACEHOLDERS[provider];
  if (modelHintEl) {
    if (provider === 'google') {
      modelHintEl.textContent =
        'Gemma 4 models run via Gemini API and use the same key. gemma-4-31b-it is recommended for quality.';
      modelHintEl.hidden = false;
    } else {
      modelHintEl.hidden = true;
    }
  }
}

function updateNoKeyBanner(): void {
  if (!noKeyBanner) return;
  const hasAny = (Object.keys(keyInputs) as LLMProvider[]).some(
    (p) => !!keyInputs[p].value.trim(),
  );
  if (hasAny) {
    noKeyBanner.setAttribute('hidden', '');
  } else {
    noKeyBanner.removeAttribute('hidden');
  }
}

function validateKey(provider: LLMProvider): void {
  const value = keyInputs[provider].value.trim();
  const warn = warnEls[provider];
  if (!value) {
    warn.hidden = true;
    warn.textContent = '';
    return;
  }
  const message = KEY_VALIDATORS[provider](value);
  if (message) {
    warn.textContent = `Warning: ${message}`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
    warn.textContent = '';
  }
}

function showStatus(message: string, kind: 'ok' | 'error'): void {
  statusEl.textContent = message;
  statusEl.classList.remove('status-ok', 'status-error');
  statusEl.classList.add(kind === 'ok' ? 'status-ok' : 'status-error');
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  if (kind === 'ok') {
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('status-ok');
    }, 2500);
  }
}

function populate(settings: ExtensionSettings): void {
  const radio = form.querySelector<HTMLInputElement>(
    `input[name="provider"][value="${settings.provider}"]`,
  );
  if (radio) radio.checked = true;

  keyInputs.anthropic.value = settings.apiKeys.anthropic ?? '';
  keyInputs.openai.value = settings.apiKeys.openai ?? '';
  keyInputs.google.value = settings.apiKeys.google ?? '';

  modelInput.value = settings.model ?? '';
  updateModelPlaceholder();

  (Object.keys(keyInputs) as LLMProvider[]).forEach(validateKey);
  updateNoKeyBanner();
}

function wireRevealButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('button.reveal').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.target;
      if (!id) return;
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      const willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      btn.textContent = willShow ? 'Hide' : 'Show';
    });
  });
}

function wireProviderRadios(): void {
  form.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      // The model override is a single shared field. Carrying e.g.
      // "claude-opus-4-7" into OpenAI silently breaks generation — clear
      // it so the new provider's default placeholder applies on Save.
      modelInput.value = '';
      updateModelPlaceholder();
    });
  });
}

function wireKeyValidation(): void {
  (Object.keys(keyInputs) as LLMProvider[]).forEach((provider) => {
    keyInputs[provider].addEventListener('input', () => validateKey(provider));
  });
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const provider = selectedProvider();
  const apiKeys: Partial<Record<LLMProvider, string>> = {};
  (Object.keys(keyInputs) as LLMProvider[]).forEach((p) => {
    apiKeys[p] = keyInputs[p].value.trim();
  });

  const modelValue = modelInput.value.trim();
  const patch: Partial<ExtensionSettings> = {
    provider,
    apiKeys,
    model: modelValue || undefined,
  };

  try {
    await setSettings(patch);
    showStatus('Saved.', 'ok');
    updateNoKeyBanner();
  } catch (e) {
    showStatus(`Error: ${(e as Error).message}`, 'error');
  }
}

async function init(): Promise<void> {
  wireRevealButtons();
  wireProviderRadios();
  wireKeyValidation();
  form.addEventListener('submit', handleSubmit);

  // No-key banner: toggle help links
  noKeyHelpToggle?.addEventListener('click', () => {
    if (!noKeyLinks) return;
    const hidden = noKeyLinks.hasAttribute('hidden');
    if (hidden) noKeyLinks.removeAttribute('hidden');
    else noKeyLinks.setAttribute('hidden', '');
  });

  // Update banner as keys are typed
  (Object.keys(keyInputs) as LLMProvider[]).forEach((p) => {
    keyInputs[p].addEventListener('input', updateNoKeyBanner);
  });

  wireKeybinds();

  try {
    const settings = await getSettings();
    populate(settings);
    populateKeybinds(settings.keybinds);
  } catch (e) {
    showStatus(`Error loading settings: ${(e as Error).message}`, 'error');
  }
}

// ---- Keybinds section ----

const KEYBIND_KEYS: Array<keyof KeybindSettings> = [
  'overlay',
  'refineLast',
  'quickToggle',
];

const keybindsStatusEl = document.getElementById(
  'keybinds-status',
) as HTMLSpanElement | null;
let keybindsStatusTimer: number | undefined;

function showKeybindsStatus(message: string, kind: 'ok' | 'error'): void {
  if (!keybindsStatusEl) return;
  keybindsStatusEl.textContent = message;
  keybindsStatusEl.classList.remove('status-ok', 'status-error');
  keybindsStatusEl.classList.add(kind === 'ok' ? 'status-ok' : 'status-error');
  if (keybindsStatusTimer !== undefined) window.clearTimeout(keybindsStatusTimer);
  if (kind === 'ok') {
    keybindsStatusTimer = window.setTimeout(() => {
      if (!keybindsStatusEl) return;
      keybindsStatusEl.textContent = '';
      keybindsStatusEl.classList.remove('status-ok');
    }, 2200);
  }
}

function keybindInput(key: keyof KeybindSettings): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    `input.keybind-input[data-keybind-input="${key}"]`,
  );
}

function keybindWarn(key: keyof KeybindSettings): HTMLParagraphElement | null {
  return document.querySelector<HTMLParagraphElement>(
    `p.keybind-warn[data-keybind-warn="${key}"]`,
  );
}

function keybindRow(key: keyof KeybindSettings): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.keybind-row[data-keybind="${key}"]`,
  );
}

const KEYBIND_LABELS: Record<keyof KeybindSettings, string> = {
  overlay: 'the "Open BOB" shortcut',
  refineLast: 'the "Refine last feature" shortcut',
  quickToggle: 'the "Quick-toggle bar" shortcut',
};

// Re-checks every keybind row against (a) the other two rows and (b)
// Chrome reserved combos. Updates the inline red warning + adds a
// .has-conflict class on the row for the bordered/tinted treatment.
function refreshKeybindWarnings(): void {
  const current: Record<keyof KeybindSettings, string> = {
    overlay: keybindInput('overlay')?.value ?? '',
    refineLast: keybindInput('refineLast')?.value ?? '',
    quickToggle: keybindInput('quickToggle')?.value ?? '',
  };
  for (const key of KEYBIND_KEYS) {
    const warn = keybindWarn(key);
    const row = keybindRow(key);
    if (!warn || !row) continue;
    const others = KEYBIND_KEYS.filter((k) => k !== key).map((k) => ({
      hotkey: current[k],
      label: KEYBIND_LABELS[k],
    }));
    const conflict = findConflict(current[key], others);
    if (conflict) {
      warn.textContent = conflict.message;
      warn.removeAttribute('hidden');
      row.classList.add('has-conflict');
    } else {
      warn.textContent = '';
      warn.setAttribute('hidden', '');
      row.classList.remove('has-conflict');
    }
  }
}

function populateKeybinds(keybinds: Partial<KeybindSettings> | undefined): void {
  for (const key of KEYBIND_KEYS) {
    const input = keybindInput(key);
    if (!input) continue;
    input.value = keybinds?.[key] ?? DEFAULT_KEYBINDS[key];
  }
  refreshKeybindWarnings();
}

async function persistKeybind(
  key: keyof KeybindSettings,
  value: string | undefined,
): Promise<void> {
  try {
    const current = await getSettings();
    const nextBinds: Partial<KeybindSettings> = {
      ...(current.keybinds ?? {}),
      [key]: value ?? DEFAULT_KEYBINDS[key],
    };
    await setSettings({ keybinds: nextBinds });
    showKeybindsStatus('Saved.', 'ok');
  } catch (e) {
    showKeybindsStatus(`Error: ${(e as Error).message}`, 'error');
  }
}

function wireKeybinds(): void {
  for (const key of KEYBIND_KEYS) {
    const input = keybindInput(key);
    const reset = document.querySelector<HTMLButtonElement>(
      `button.keybind-reset[data-keybind-reset="${key}"]`,
    );
    if (!input) continue;

    input.addEventListener('focus', () => {
      input.classList.add('capturing');
      input.dataset.previous = input.value;
      input.value = '';
      input.placeholder = 'press your combo…';
    });

    input.addEventListener('blur', () => {
      input.classList.remove('capturing');
      if (!input.value && input.dataset.previous) {
        input.value = input.dataset.previous;
      }
      delete input.dataset.previous;
      input.placeholder = 'click here, then press your combo';
    });

    input.addEventListener('keydown', (e) => {
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
      input.value = hk;
      delete input.dataset.previous; // commit; don't restore on blur
      refreshKeybindWarnings();
      input.blur();
      void persistKeybind(key, hk);
    });

    reset?.addEventListener('click', () => {
      const def = DEFAULT_KEYBINDS[key];
      input.value = def;
      refreshKeybindWarnings();
      void persistKeybind(key, def);
    });
  }
}

// ---- Demo seed ----

// DEMO FEATURES: re-verify selectors before any demo. Sites
// change DOM frequently. Last verified: <leave blank for human
// to fill in after testing>.
const DEMO_FEATURES = [
  {
    "code": "(function(){ try { const SLUG = 'reddit-reviews-btn'; function addButton() { const titleDiv = document.getElementById('title_feature_div'); if (!titleDiv) return; if (document.querySelector('[data-bob=\"' + SLUG + '\"]')) return; const productTitleEl = document.getElementById('productTitle'); if (!productTitleEl) return; const productName = productTitleEl.textContent.trim(); if (!productName) return; const redditUrl = 'https://www.reddit.com/search/?q=' + encodeURIComponent(productName + ' review') + '&sort=relevance'; const wrapper = document.createElement('div'); wrapper.setAttribute('data-bob', SLUG); wrapper.style.cssText = 'margin: 6px 0 8px 0; display: flex; align-items: center;'; const btn = document.createElement('a'); btn.href = redditUrl; btn.target = '_blank'; btn.rel = 'noopener noreferrer'; btn.setAttribute('role', 'button'); /* Amazon button base styles */ btn.style.cssText = [ 'display: inline-flex', 'align-items: center', 'gap: 6px', 'padding: 6px 12px', 'font-size: 13px', 'font-family: \"Amazon Ember\", Arial, sans-serif', 'font-weight: 500', 'color: #111', 'background: linear-gradient(to bottom, #f9e4d4 0%, #f5c9a8 100%)', 'border: 1px solid #c0622a', 'border-radius: 3px', 'box-shadow: 0 1px 0 rgba(255,255,255,.4) inset, 0 1px 2px rgba(0,0,0,.15)', 'cursor: pointer', 'text-decoration: none', 'white-space: nowrap', 'transition: filter .1s' ].join(';'); btn.addEventListener('mouseover', function(){ btn.style.filter = 'brightness(0.94)'; }); btn.addEventListener('mouseout', function(){ btn.style.filter = ''; }); /* Reddit Snoo SVG icon */ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true'); const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx', '10'); circle.setAttribute('cy', '10'); circle.setAttribute('r', '10'); circle.setAttribute('fill', '#FF4500'); const snoo = document.createElementNS('http://www.w3.org/2000/svg', 'path'); snoo.setAttribute('fill', 'white'); snoo.setAttribute('d', 'M16.67 10a1.46 1.46 0 0 0-2.47-1 7.12 7.12 0 0 0-3.85-1.23l.65-3.08 2.13.45a1 1 0 1 0 .24-.66l-2.38-.5a.25.25 0 0 0-.3.19l-.73 3.44a7.14 7.14 0 0 0-3.89 1.23 1.46 1.46 0 1 0-1.61 2.39 2.9 2.9 0 0 0 0 .44c0 2.24 2.61 4.06 5.83 4.06s5.83-1.82 5.83-4.06a2.9 2.9 0 0 0 0-.44 1.46 1.46 0 0 0 .46-1.23zM7.27 11a1 1 0 1 1 1 1 1 1 0 0 1-1-1zm5.58 2.65a3.56 3.56 0 0 1-2.85.58 3.56 3.56 0 0 1-2.85-.58.25.25 0 0 1 .35-.35 3.12 3.12 0 0 0 2.5.43 3.12 3.12 0 0 0 2.5-.43.25.25 0 0 1 .35.35zm-.16-1.65a1 1 0 1 1 1-1 1 1 0 0 1-1 1z'); svg.appendChild(circle); svg.appendChild(snoo); const label = document.createElement('span'); label.textContent = 'Reddit reviews'; btn.appendChild(svg); btn.appendChild(label); wrapper.appendChild(btn); titleDiv.insertAdjacentElement ? titleDiv.after(wrapper) : titleDiv.parentNode.insertBefore(wrapper, titleDiv.nextSibling); } if (window.__bobObserve) { window.__bobObserve(addButton, { slug: SLUG }); } else { addButton(); const obs = new MutationObserver(function(){ addButton(); }); obs.observe(document.body, { childList: true, subtree: true }); } } catch(e){ console.error('[bob]', e); window.__bobLastError = String(e); } })();",
    "createdAt": 1777186747250,
    "description": "Adds a Reddit-orange styled button next to the Amazon product title that opens a Reddit review search for the current product in a new tab.",
    "enabled": true,
    "errorCount": 0,
    "id": "1a311e22-b5a3-4fe6-a509-fc4493d51743",
    "iterationNumber": 0,
    "lastRanAt": 1777187560256,
    "name": "Reddit Reviews Button",
    "runCount": 5,
    "urlPattern": "*://*.amazon.com/*/dp/*",
    "userPrompt": "On Amazon product pages, add a button next to the product title that says \"Reddit reviews\" — when clicked it should open a new tab with a Reddit search for this product's name plus \"review\". Make the button visually match Amazon's existing buttons but with a Reddit-orange accent. Use window.__bobObserve so it works after navigating between products."
  },
  {
    "code": "(function(){ try {\n  const SLUG = 'wiki-related-sidebar';\n  if (document.querySelector('[data-bob=\"' + SLUG + '\"]')) return;\n\n  // Only run on article pages (not Special:, File:, etc.)\n  const path = location.pathname;\n  if (!/^\\/wiki\\/[^:]+$/.test(path)) return;\n\n  // --- Build sidebar shell immediately ---\n  const sidebar = document.createElement('div');\n  sidebar.setAttribute('data-bob', SLUG);\n  Object.assign(sidebar.style, {\n    position: 'fixed',\n    top: '80px',\n    right: '0',\n    width: '220px',\n    maxHeight: 'calc(100vh - 100px)',\n    overflowY: 'auto',\n    background: '#f8f9fa',\n    borderLeft: '1px solid #a2a9b1',\n    borderBottom: '1px solid #a2a9b1',\n    borderTop: '1px solid #a2a9b1',\n    borderRadius: '2px 0 0 2px',\n    padding: '12px 14px',\n    fontFamily: \"'Linux Libertine', 'Georgia', serif\",\n    fontSize: '13px',\n    lineHeight: '1.5',\n    color: '#202122',\n    zIndex: '9999',\n    boxSizing: 'border-box',\n  });\n\n  const heading = document.createElement('div');\n  Object.assign(heading.style, {\n    fontFamily: \"'Linux Libertine', 'Georgia', serif\",\n    fontSize: '13px',\n    fontWeight: 'bold',\n    borderBottom: '1px solid #a2a9b1',\n    paddingBottom: '6px',\n    marginBottom: '8px',\n    color: '#54595d',\n    letterSpacing: '0.02em',\n    textTransform: 'uppercase',\n  });\n  heading.textContent = 'Related articles';\n  sidebar.appendChild(heading);\n\n  const list = document.createElement('ul');\n  Object.assign(list.style, {\n    listStyle: 'none',\n    margin: '0',\n    padding: '0',\n  });\n  sidebar.appendChild(list);\n\n  const status = document.createElement('li');\n  status.textContent = 'Loading…';\n  Object.assign(status.style, { color: '#54595d', fontStyle: 'italic' });\n  list.appendChild(status);\n\n  document.body.appendChild(sidebar);\n\n  // --- Fetch related articles via MediaWiki API ---\n  const pageTitle = decodeURIComponent(path.replace('/wiki/', ''));\n\n  // Step 1: get internal links from the article\n  const linksUrl = 'https://en.wikipedia.org/w/api.php?action=query&titles='\n    + encodeURIComponent(pageTitle)\n    + '&prop=links&pllimit=50&plnamespace=0&format=json&origin=*';\n\n  fetch(linksUrl)\n    .then(r => r.json())\n    .then(data => {\n      const pages = data.query && data.query.pages;\n      if (!pages) throw new Error('No pages in response');\n      const page = Object.values(pages)[0];\n      const links = (page.links || []).map(l => l.title);\n      // Filter out likely meta pages\n      const filtered = links.filter(t =>\n        !t.startsWith('List of') &&\n        !t.startsWith('Index of') &&\n        t !== pageTitle\n      );\n      // Pick up to 5 spread across the list for variety\n      const step = Math.max(1, Math.floor(filtered.length / 5));\n      const picks = [];\n      for (let i = 0; picks.length < 5 && i < filtered.length; i += step) {\n        picks.push(filtered[i]);\n      }\n      // Fallback: just take first 5 if step logic left gaps\n      if (picks.length < 5) {\n        for (let i = 0; picks.length < 5 && i < filtered.length; i++) {\n          if (!picks.includes(filtered[i])) picks.push(filtered[i]);\n        }\n      }\n      return picks;\n    })\n    .then(titles => {\n      // Step 2: get short descriptions for each title\n      const descUrl = 'https://en.wikipedia.org/w/api.php?action=query&titles='\n        + titles.map(encodeURIComponent).join('|')\n        + '&prop=description&format=json&origin=*';\n      return fetch(descUrl)\n        .then(r => r.json())\n        .then(data => {\n          const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];\n          return titles.map(t => {\n            const p = pages.find(pg => pg.title === t) || {};\n            return { title: t, description: p.description || '' };\n          });\n        });\n    })\n    .then(articles => {\n      list.removeChild(status);\n      articles.forEach((art, i) => {\n        const li = document.createElement('li');\n        Object.assign(li.style, {\n          marginBottom: i < articles.length - 1 ? '10px' : '0',\n          paddingBottom: i < articles.length - 1 ? '10px' : '0',\n          borderBottom: i < articles.length - 1 ? '1px solid #eaecf0' : 'none',\n        });\n\n        const a = document.createElement('a');\n        a.href = '/wiki/' + encodeURIComponent(art.title.replace(/ /g, '_'));\n        a.textContent = art.title;\n        Object.assign(a.style, {\n          color: '#0645ad',\n          textDecoration: 'none',\n          fontWeight: 'bold',\n          display: 'block',\n          marginBottom: '2px',\n          fontFamily: \"'Linux Libertine', 'Georgia', serif\",\n          fontSize: '13px',\n        });\n        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });\n        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });\n        li.appendChild(a);\n\n        if (art.description) {\n          const desc = document.createElement('span');\n          desc.textContent = art.description.charAt(0).toUpperCase() + art.description.slice(1);\n          Object.assign(desc.style, {\n            color: '#54595d',\n            fontSize: '12px',\n            fontFamily: \"'Helvetica Neue', 'Helvetica', sans-serif\",\n            display: 'block',\n          });\n          li.appendChild(desc);\n        }\n\n        list.appendChild(li);\n      });\n    })\n    .catch(err => {\n      status.textContent = 'Could not load related articles.';\n      console.error('[bob]', err);\n    });\n\n} catch(e){ console.error('[bob]', e); window.__bobLastError = String(e); } })();",
    "createdAt": 1777195111738,
    "description": "Fetches 5 related articles from the Wikipedia API and displays them in a fixed right-side sidebar styled to match Wikipedia's native design.",
    "enabled": true,
    "errorCount": 0,
    "id": "f192090a-22fc-443d-b6be-d3e7f2fe928a",
    "iterationNumber": 0,
    "lastRanAt": 1777195111745,
    "name": "Wikipedia Related Articles Sidebar",
    "runCount": 1,
    "urlPattern": "*://en.wikipedia.org/wiki/*",
    "userPrompt": "On Wikipedia article pages, recommend 5 related articles and pin it to the right side of the screen as a fixed-position sidebar that's always visible while scrolling. Style it to feel native to Wikipedia — clean, light background, no shadows, simple typography."
  },
  {
    "code": "(function(){ try {\n  const SLUG = 'hn-saved-stories';\n  const STORAGE_KEY = 'bob-hn-saved';\n\n  // ── helpers ──────────────────────────────────────────────────────────────\n  function loadSaved(cb) {\n    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {\n      chrome.storage.local.get([STORAGE_KEY], function(res) { cb(res[STORAGE_KEY] || {}); });\n    } else {\n      try { cb(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }\n      catch(e) { cb({}); }\n    }\n  }\n\n  function persistSaved(saved) {\n    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {\n      chrome.storage.local.set({ [STORAGE_KEY]: saved });\n    } else {\n      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));\n    }\n  }\n\n  // ── panel ────────────────────────────────────────────────────────────────\n  function getOrCreatePanel() {\n    let panel = document.querySelector('[data-bob=\"' + SLUG + '-panel\"]');\n    if (panel) return panel;\n\n    panel = document.createElement('div');\n    panel.setAttribute('data-bob', SLUG + '-panel');\n    Object.assign(panel.style, {\n      position: 'fixed', bottom: '16px', right: '16px', width: '300px',\n      maxHeight: '420px', background: '#fff', border: '1px solid #ccc',\n      borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.18)',\n      fontFamily: 'sans-serif', fontSize: '13px', zIndex: '99999',\n      display: 'flex', flexDirection: 'column', overflow: 'hidden'\n    });\n\n    // header\n    const header = document.createElement('div');\n    Object.assign(header.style, {\n      background: '#ff6600', color: '#fff', padding: '7px 10px',\n      fontWeight: 'bold', display: 'flex', alignItems: 'center',\n      justifyContent: 'space-between', flexShrink: '0'\n    });\n    const headerTitle = document.createElement('span');\n    headerTitle.setAttribute('data-bob', SLUG + '-header-title');\n    headerTitle.textContent = 'Saved Stories (0)';\n    header.appendChild(headerTitle);\n\n    const clearBtn = document.createElement('button');\n    clearBtn.textContent = 'Clear all';\n    Object.assign(clearBtn.style, {\n      background: 'rgba(255,255,255,.25)', border: 'none', color: '#fff',\n      borderRadius: '4px', padding: '2px 7px', cursor: 'pointer', fontSize: '11px'\n    });\n    clearBtn.addEventListener('click', function() {\n      persistSaved({});\n      renderPanel({});\n      refreshButtons({});\n    });\n    header.appendChild(clearBtn);\n    panel.appendChild(header);\n\n    // list\n    const list = document.createElement('div');\n    list.setAttribute('data-bob', SLUG + '-list');\n    Object.assign(list.style, {\n      overflowY: 'auto', padding: '6px 8px', flex: '1'\n    });\n    panel.appendChild(list);\n\n    document.body.appendChild(panel);\n    return panel;\n  }\n\n  function renderPanel(saved) {\n    const panel = getOrCreatePanel();\n    const list = panel.querySelector('[data-bob=\"' + SLUG + '-list\"]');\n    const headerTitle = panel.querySelector('[data-bob=\"' + SLUG + '-header-title\"]');\n    const keys = Object.keys(saved);\n    headerTitle.textContent = 'Saved Stories (' + keys.length + ')';\n\n    // clear existing items\n    while (list.firstChild) list.removeChild(list.firstChild);\n\n    if (keys.length === 0) {\n      const empty = document.createElement('div');\n      Object.assign(empty.style, { color: '#999', padding: '8px 2px', textAlign: 'center' });\n      empty.textContent = 'No saved stories yet';\n      list.appendChild(empty);\n      return;\n    }\n\n    keys.forEach(function(id) {\n      const item = saved[id];\n      const row = document.createElement('div');\n      Object.assign(row.style, {\n        display: 'flex', alignItems: 'flex-start', padding: '5px 2px',\n        borderBottom: '1px solid #f0f0f0', gap: '6px'\n      });\n\n      const link = document.createElement('a');\n      link.href = item.url;\n      link.target = '_blank';\n      link.rel = 'noopener noreferrer';\n      link.textContent = item.title;\n      Object.assign(link.style, {\n        flex: '1', color: '#333', textDecoration: 'none',\n        lineHeight: '1.4', wordBreak: 'break-word'\n      });\n      link.addEventListener('mouseover', function() { link.style.textDecoration = 'underline'; });\n      link.addEventListener('mouseout', function() { link.style.textDecoration = 'none'; });\n      row.appendChild(link);\n\n      const xBtn = document.createElement('button');\n      xBtn.textContent = '×';\n      Object.assign(xBtn.style, {\n        border: 'none', background: 'none', color: '#aaa', cursor: 'pointer',\n        fontSize: '16px', lineHeight: '1', padding: '0 2px', flexShrink: '0'\n      });\n      xBtn.title = 'Remove';\n      xBtn.addEventListener('click', function() {\n        loadSaved(function(s) {\n          delete s[id];\n          persistSaved(s);\n          renderPanel(s);\n          refreshButtons(s);\n        });\n      });\n      row.appendChild(xBtn);\n      list.appendChild(row);\n    });\n  }\n\n  // ── buttons ───────────────────────────────────────────────────────────────\n  function refreshButtons(saved) {\n    document.querySelectorAll('[data-bob=\"' + SLUG + '-btn\"]').forEach(function(btn) {\n      const id = btn.getAttribute('data-bob-id');\n      const isSaved = !!saved[id];\n      btn.textContent = isSaved ? 'Saved' : 'Save';\n      btn.style.color = isSaved ? '#fff' : '#888';\n      btn.style.background = isSaved ? '#ff6600' : '#f5f5f5';\n      btn.style.borderColor = isSaved ? '#e05500' : '#ccc';\n    });\n  }\n\n  function applyToRows(saved) {\n    document.querySelectorAll('tr.athing.submission').forEach(function(row) {\n      const id = row.id;\n      if (!id) return;\n      const titleLine = row.querySelector('.titleline');\n      if (!titleLine) return;\n\n      // idempotency — skip if button already added\n      if (titleLine.querySelector('[data-bob=\"' + SLUG + '-btn\"]')) return;\n\n      const anchor = titleLine.querySelector('a');\n      if (!anchor) return;\n      const title = anchor.textContent.trim();\n      const url = anchor.href;\n\n      const btn = document.createElement('button');\n      btn.setAttribute('data-bob', SLUG + '-btn');\n      btn.setAttribute('data-bob-id', id);\n      const isSaved = !!saved[id];\n      btn.textContent = isSaved ? 'Saved' : 'Save';\n      Object.assign(btn.style, {\n        marginLeft: '8px', padding: '1px 7px', fontSize: '11px',\n        cursor: 'pointer', borderRadius: '4px', verticalAlign: 'middle',\n        border: '1px solid', transition: 'all .15s',\n        color: isSaved ? '#fff' : '#888',\n        background: isSaved ? '#ff6600' : '#f5f5f5',\n        borderColor: isSaved ? '#e05500' : '#ccc'\n      });\n\n      btn.addEventListener('click', function(e) {\n        e.preventDefault();\n        loadSaved(function(s) {\n          if (s[id]) {\n            delete s[id];\n          } else {\n            s[id] = { title: title, url: url };\n          }\n          persistSaved(s);\n          renderPanel(s);\n          refreshButtons(s);\n        });\n      });\n\n      titleLine.appendChild(btn);\n    });\n  }\n\n  // ── init ──────────────────────────────────────────────────────────────────\n  loadSaved(function(saved) {\n    getOrCreatePanel();\n    renderPanel(saved);\n    applyToRows(saved);\n  });\n\n  if (typeof window.__bobObserve === 'function') {\n    window.__bobObserve(function() {\n      loadSaved(function(saved) {\n        applyToRows(saved);\n        renderPanel(saved);\n      });\n    }, { slug: SLUG });\n  } else {\n    const obs = new MutationObserver(function() {\n      loadSaved(function(saved) { applyToRows(saved); });\n    });\n    obs.observe(document.body, { childList: true, subtree: true });\n  }\n\n} catch(e){ console.error('[bob]', e); window.__bobLastError = String(e); } })();",
    "createdAt": 1777187446708,
    "description": "Adds a Save button next to each Hacker News story title, stores saved stories in chrome.storage.local, and shows them in a fixed bottom-right panel with clickable links and individual remove buttons.",
    "enabled": true,
    "errorCount": 3,
    "id": "2d1992b7-c19b-46bd-8f24-f962322df18a",
    "iterationNumber": 0,
    "lastRanAt": 1777194652414,
    "name": "HN Save Stories Panel",
    "runCount": 12,
    "urlPattern": "*://news.ycombinator.com/*",
    "userPrompt": "On news.ycombinator.com story listings, add a small \"Save\" button next to each story title. When clicked, save that story (title and link) to chrome.storage.local under a key like \"bob-hn-saved\", and add a fixed-position panel at the bottom right of the screen that shows my saved stories with their titles as clickable links. The panel should have a small header with a count, and an \"x\" to remove individual saves. Make the saved-state visible: clicked Save buttons show \"Saved\" in a different color. Use window.__bobObserve since HN paginates with \"More\" links."
  },
  {
    "code": "(function(){ try {\n  const SLUG = 'so-stale';\n  const THREE_YEARS_MS = 3 * 365.25 * 24 * 60 * 60 * 1000;\n\n  function applyStaleWarnings() {\n    const answers = document.querySelectorAll('.answer[data-answerid], .answer');\n    answers.forEach(function(answer) {\n      // Idempotency: skip if banner already exists in this answer\n      if (answer.querySelector('[data-bob=\"' + SLUG + '\"]')) return;\n\n      // Find the \"answered\" time element — look in .post-signature for an action label containing \"answered\"\n      let answeredTime = null;\n      const postSignatures = answer.querySelectorAll('.post-signature');\n      postSignatures.forEach(function(sig) {\n        const actionEl = sig.querySelector('.user-action-time');\n        if (actionEl && actionEl.textContent.toLowerCase().includes('answered')) {\n          const t = sig.querySelector('time[datetime]');\n          if (t) answeredTime = t;\n        }\n      });\n\n      // Fallback: first time[datetime] in the answer\n      if (!answeredTime) {\n        answeredTime = answer.querySelector('time[datetime]');\n      }\n      if (!answeredTime) return;\n\n      const dateStr = answeredTime.getAttribute('datetime');\n      const answerDate = new Date(dateStr);\n      if (isNaN(answerDate.getTime())) return;\n\n      const ageMs = Date.now() - answerDate.getTime();\n      if (ageMs < THREE_YEARS_MS) return;\n\n      const years = Math.floor(ageMs / THREE_YEARS_MS);\n\n      // Find the answer body cell to prepend into\n      const target = answer.querySelector('.answercell') ||\n                     answer.querySelector('.post-layout') ||\n                     answer;\n\n      // Build the banner using only safe DOM methods\n      const banner = document.createElement('div');\n      banner.setAttribute('data-bob', SLUG);\n      banner.style.background    = '#fff3cd';\n      banner.style.borderLeft    = '4px solid #d6a700';\n      banner.style.padding       = '8px 12px';\n      banner.style.marginBottom  = '12px';\n      banner.style.fontSize      = '13px';\n      banner.style.lineHeight    = '1.4';\n      banner.style.borderRadius  = '2px';\n      banner.style.color         = '#5a4000';\n      banner.style.fontWeight    = 'normal';\n\n      banner.textContent = '\\u26A0 This answer is ' + years +\n        ' years old \\u2014 the API or syntax may have changed';\n\n      target.insertBefore(banner, target.firstChild);\n    });\n  }\n\n  if (window.__bobObserve) {\n    window.__bobObserve(applyStaleWarnings, { slug: SLUG });\n  } else {\n    applyStaleWarnings();\n    const obs = new MutationObserver(applyStaleWarnings);\n    obs.observe(document.body, { childList: true, subtree: true });\n  }\n} catch(e){ console.error('[bob]', e); window.__bobLastError = String(e); } })();",
    "createdAt": 1777202180787,
    "description": "Prepends a yellow warning banner to any Stack Overflow answer older than 3 years, showing the exact age in years.",
    "enabled": true,
    "errorCount": 0,
    "id": "038e9437-f1e5-4e56-a048-42449ab1a7a5",
    "iterationNumber": 0,
    "lastRanAt": 1777202217968,
    "name": "SO Stale Answer Warning",
    "runCount": 3,
    "urlPattern": "*://stackoverflow.com/questions/*",
    "userPrompt": "On stackoverflow.com question pages, find every answer (selector .answer or [data-answerid]). For each answer, find the \"answered\" date — there's a <time> element with a datetime attribute inside the answer's footer. Parse it. If the answer is older than 3 years, prepend a small yellow warning banner inside the answer that says \"⚠ This answer is X years old — the API or syntax may have changed\" where X is the actual year count. Style: light yellow background (#fff3cd), dark yellow border on the left, small padding, sits at the top of the answer body. Tag with data-bob='so-stale'. Do NOT use query_dom."
  },
];

const loadDemosBtn = document.getElementById('load-demos') as HTMLButtonElement | null;
const demoStatusEl = document.getElementById('demo-status') as HTMLSpanElement | null;

async function loadDemos(): Promise<void> {
  if (!loadDemosBtn) return;
  loadDemosBtn.disabled = true;
  // Skip demos already installed (by name) so a second click after a page
  // reload doesn't pile up duplicates and break the demo for a presenter.
  const existingNames = new Set<string>();
  try {
    const existing = await chrome.runtime.sendMessage({ type: 'LIST_FEATURES' });
    if (Array.isArray(existing)) {
      for (const f of existing) {
        if (f && typeof f.name === 'string') existingNames.add(f.name);
      }
    }
  } catch {
    // If LIST_FEATURES fails we still install — duplicates are recoverable;
    // a missing demo set isn't.
  }
  let installed = 0;
  let skipped = 0;
  for (const demo of DEMO_FEATURES) {
    if (existingNames.has(demo.name)) {
      skipped++;
      continue;
    }
    try {
      await chrome.runtime.sendMessage({
        type: 'INSTALL_FEATURE',
        feature: {
          ...demo,
          enabled: true,
          runCount: 0,
          errorCount: 0,
        },
      });
      installed++;
    } catch {
      // skip individual failures
    }
  }
  if (demoStatusEl) {
    const parts = [`Loaded ${installed} demo features.`];
    if (skipped > 0) parts.push(`${skipped} already present.`);
    demoStatusEl.textContent = parts.join(' ');
    demoStatusEl.classList.add('status-ok');
  }
}

loadDemosBtn?.addEventListener('click', () => void loadDemos());

// ---- Backup & Restore ----

const exportBtn = document.getElementById('export-btn') as HTMLButtonElement | null;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement | null;
const importFileInput = document.getElementById('import-file') as HTMLInputElement | null;
const importModeEl = document.getElementById('import-mode') as HTMLDivElement | null;
const importMergeBtn = document.getElementById('import-merge') as HTMLButtonElement | null;
const importReplaceBtn = document.getElementById('import-replace') as HTMLButtonElement | null;
const backupStatusEl = document.getElementById('backup-status') as HTMLSpanElement | null;

let pendingFile: File | null = null;

function showBackupStatus(message: string, kind: 'ok' | 'error'): void {
  if (!backupStatusEl) return;
  backupStatusEl.textContent = message;
  backupStatusEl.classList.remove('status-ok', 'status-error');
  backupStatusEl.classList.add(kind === 'ok' ? 'status-ok' : 'status-error');
}

exportBtn?.addEventListener('click', async () => {
  try {
    await exportFeatures();
    showBackupStatus('Exported.', 'ok');
  } catch (e) {
    showBackupStatus((e as Error).message || 'Export failed.', 'error');
  }
});

importBtn?.addEventListener('click', () => {
  importFileInput?.click();
});

importFileInput?.addEventListener('change', () => {
  const file = importFileInput.files?.[0];
  if (!file) return;
  pendingFile = file;
  importModeEl?.removeAttribute('hidden');
});

async function doImport(mode: 'merge' | 'replace'): Promise<void> {
  if (!pendingFile) return;
  try {
    const result = await importFeatures(pendingFile, mode);
    pendingFile = null;
    importModeEl?.setAttribute('hidden', '');
    showBackupStatus(`Imported ${result.count} feature${result.count === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    showBackupStatus((e as Error).message || 'Import failed.', 'error');
  }
}

importMergeBtn?.addEventListener('click', () => void doImport('merge'));
importReplaceBtn?.addEventListener('click', () => void doImport('replace'));

void init();
