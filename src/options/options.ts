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
    name: 'Hide YouTube Shorts',
    description: 'Hides Shorts shelves from the YouTube homepage.',
    urlPattern: '*://*.youtube.com/*',
    userPrompt: 'Hide YouTube Shorts',
    code: `(function(){try{
  var slug='hide-yt-shorts';
  if(window.__bobObserve){
    window.__bobObserve(slug,function(){
      document.querySelectorAll('ytd-rich-shelf-renderer, ytd-reel-shelf-renderer').forEach(function(el){
        if(el.getAttribute('data-bob')===slug)return;
        el.setAttribute('data-bob',slug);
        el.style.display='none';
      });
    });
  }else{
    document.querySelectorAll('ytd-rich-shelf-renderer, ytd-reel-shelf-renderer').forEach(function(el){
      el.setAttribute('data-bob',slug);
      el.style.display='none';
    });
  }
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'HN Star Titles',
    description: 'Prepends a star emoji to every Hacker News story title.',
    urlPattern: '*://news.ycombinator.com/*',
    userPrompt: 'Add stars to HN titles',
    code: `(function(){try{
  var slug='hn-star-titles';
  function apply(){
    document.querySelectorAll('.titleline > a:first-child').forEach(function(a){
      if(a.getAttribute('data-bob')===slug)return;
      a.setAttribute('data-bob',slug);
      a.textContent='\\u2b50 '+a.textContent;
    });
  }
  if(window.__bobObserve){window.__bobObserve(slug,apply);}
  else{apply();}
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'Wikipedia Dim Sidebar',
    description: 'Dims the Wikipedia sidebar to reduce visual clutter.',
    urlPattern: '*://*.wikipedia.org/*',
    userPrompt: 'Dim Wikipedia sidebar',
    code: `(function(){try{
  var slug='wp-dim-sidebar';
  var el=document.getElementById('mw-panel')||document.getElementById('mw-navigation');
  if(el&&!el.getAttribute('data-bob')){
    el.setAttribute('data-bob',slug);
    el.style.opacity='0.5';
  }
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'Reddit Hide Ads',
    description: 'Hides promoted posts on Reddit.',
    urlPattern: '*://*.reddit.com/*',
    userPrompt: 'Hide Reddit ads',
    code: `(function(){try{
  var slug='reddit-hide-ads';
  function apply(){
    document.querySelectorAll('[data-promoted="true"], shreddit-ad-post').forEach(function(el){
      if(el.getAttribute('data-bob')===slug)return;
      el.setAttribute('data-bob',slug);
      el.style.display='none';
    });
  }
  if(window.__bobObserve){window.__bobObserve(slug,apply);}
  else{apply();}
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'Example.com Tint',
    description: 'Applies a soft blue tint to example.com.',
    urlPattern: '*://example.com/*',
    userPrompt: 'Tint example.com blue',
    code: `(function(){try{
  var slug='example-tint';
  if(document.body.getAttribute('data-bob')===slug)return;
  document.body.setAttribute('data-bob',slug);
  document.body.style.backgroundColor='#e8f0fe';
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
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
